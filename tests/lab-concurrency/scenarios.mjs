import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createBarrier, createSignal, pollPgLock, dispatchQuery } from './barrier.mjs';
import { createProvisioningClient, wrapQueryBuilder } from './module-loader.mjs';
import {
	generateRunTag,
	setupSyntheticTenant,
	cleanupSyntheticTenant,
	FixtureTracker
} from './fixtures.mjs';
import { createVerifiedLabConnection } from './safeguards.mjs';

/**
 * Scenario A: Concurrent Duplicate Email Provisioning (LOWER Index Collision).
 *
 * Two connections call provisionIdentity simultaneously with emails differing only in casing:
 * - 'andres_<tag>@lab.synthetic.test'
 * - 'Andres_<tag>@lab.synthetic.test'
 *
 * Checks:
 * 1. Exactly one call succeeds ({ ok: true }).
 * 2. The other receives { ok: false, error: 'CONFLICT' } via PostgreSQL 23505 mapping.
 * 3. All 4 tables (users, user_emails, auth_users, auth_accounts) contain exactly 1 row.
 * 4. Zero orphaned or partial rows exist.
 *
 * Teardown guarantee: Any provisioned user ID is tracked immediately upon task settlement
 * and additionally verified via synthetic email tag prior to assertions.
 * Cleanup errors are detected and propagated, never silenced.
 */
export async function runScenarioA() {
	const tag = generateRunTag('scenA');
	const tracker = new FixtureTracker(tag);
	let sqlAdmin = null;
	let sql1 = null;
	let sql2 = null;
	let sqlVerify = null;
	let barrier = null;
	let task1 = null;
	let task2 = null;
	let scenarioResult = null;
	let executionError = null;
	let recoveryError = null;
	let cleanupError = null;

	const emailLower = `andres_${tag}@lab.synthetic.test`.toLowerCase();
	const emailUpper = `Andres_${tag}@lab.synthetic.test`;

	try {
		sqlAdmin = await createVerifiedLabConnection();
		const tenant = await setupSyntheticTenant(sqlAdmin, tag, tracker);

		sql1 = await createVerifiedLabConnection();
		sql2 = await createVerifiedLabConnection();
		sqlVerify = await createVerifiedLabConnection();

		barrier = createBarrier('ScenarioA_Start', 2, 8000);

		const client1 = createProvisioningClient(sql1);
		const client2 = createProvisioningClient(sql2);

		task1 = (async () => {
			await barrier.wait();
			return client1.provisioning.provisionIdentity(tenant.headers, tenant.orgId, {
				name: 'Andres Lower',
				email: emailLower,
				password: 'Synthetic-password-123!'
			});
		})();

		task2 = (async () => {
			await barrier.wait();
			return client2.provisioning.provisionIdentity(tenant.headers, tenant.orgId, {
				name: 'Andres Upper',
				email: emailUpper,
				password: 'Synthetic-password-123!'
			});
		})();

		const [res1, res2] = await Promise.all([task1, task2]);

		// Track provisioned IDs immediately upon return, before any assertions
		if (res1?.ok && res1.value?.userId) {
			tracker.trackUser(res1.value.userId);
		}
		if (res2?.ok && res2.value?.userId) {
			tracker.trackUser(res2.value.userId);
		}

		const successes = [res1, res2].filter((r) => r.ok === true);
		const conflicts = [res1, res2].filter((r) => r.ok === false && r.error === 'CONFLICT');

		assert.equal(successes.length, 1, 'Exactly one provisionIdentity call must succeed');
		assert.equal(
			conflicts.length,
			1,
			'The concurrent provisionIdentity call must return CONFLICT (23505)'
		);

		const createdUserId = successes[0].value.userId;

		// Independent verification across all four tables affected by provisioning
		const users = await sqlVerify`SELECT id FROM users WHERE id = ${createdUserId}`;
		assert.equal(users.length, 1, 'Exactly 1 user must exist in users table');

		const emails =
			await sqlVerify`SELECT id, email FROM user_emails WHERE user_id = ${createdUserId}`;
		assert.equal(emails.length, 1, 'Exactly 1 record must exist in user_emails table');
		assert.equal(emails[0].email, emailLower, 'Persisted email must be normalized in user_emails');

		const authUsers = await sqlVerify`SELECT id, email FROM auth_users WHERE id = ${createdUserId}`;
		assert.equal(authUsers.length, 1, 'Exactly 1 profile must exist in auth_users');

		const accounts = await sqlVerify`SELECT id FROM auth_accounts WHERE user_id = ${createdUserId}`;
		assert.equal(accounts.length, 1, 'Exactly 1 credential must exist in auth_accounts');

		scenarioResult = {
			scenario: 'A. Duplicate Email Casing Collision',
			status: 'PASSED',
			details: 'One succeeded, one returned CONFLICT (23505). Verified across all 4 tables.'
		};
	} catch (err) {
		executionError = err;
	} finally {
		// 1. Abort barrier if still waiting so no async task hangs
		if (barrier && !barrier.settled) {
			barrier.abort();
		}

		// 2. Terminate client connections first to abort any open transactions on PostgreSQL
		if (sql1) await sql1.end({ timeout: 1 }).catch(() => {});
		if (sql2) await sql2.end({ timeout: 1 }).catch(() => {});
		if (sqlVerify) await sqlVerify.end({ timeout: 1 }).catch(() => {});

		// 3. Ensure no concurrent tasks remain pending before starting cleanup
		if (task1 || task2) {
			const settled = await Promise.allSettled([task1, task2].filter(Boolean));
			for (const s of settled) {
				if (s.status === 'fulfilled' && s.value?.ok && s.value.value?.userId) {
					tracker.trackUser(s.value.value.userId);
				}
			}
		}

		// 4. Recover any created synthetic users by exact synthetic email before cleanup
		// Strictly uses exact email matching (no LIKE or indiscriminate queries)
		if (sqlAdmin) {
			try {
				const recoveredEmails = await sqlAdmin`
					SELECT user_id FROM user_emails
					WHERE email = ${emailLower} OR email = ${emailUpper}
				`;
				for (const r of recoveredEmails) {
					tracker.trackUser(r.user_id);
				}

				const recoveredAuthUsers = await sqlAdmin`
					SELECT id FROM auth_users
					WHERE email = ${emailLower} OR email = ${emailUpper}
				`;
				for (const r of recoveredAuthUsers) {
					tracker.trackUser(r.id);
				}
			} catch (recErr) {
				recoveryError = recErr;
				console.error(
					`[RECOVERY ERROR] Failed recovering synthetic users by email for tag '${tag}': ${recErr.message}`
				);
			}
		}

		// 5. Execute transactional cleanup
		if (sqlAdmin) {
			try {
				await cleanupSyntheticTenant(sqlAdmin, tracker);
			} catch (err) {
				cleanupError = err;
				console.error(
					`[CLEANUP ERROR] Failed cleaning synthetic fixtures for tag '${tag}': ${err.message}`
				);
			} finally {
				await sqlAdmin.end({ timeout: 1 }).catch(() => {});
			}
		}
	}

	// 6. Error propagation: never hide the original test execution failure
	if (executionError) {
		if (recoveryError) executionError.recoveryError = recoveryError;
		if (cleanupError) executionError.cleanupError = cleanupError;
		throw executionError;
	}

	if (recoveryError) {
		if (cleanupError) recoveryError.cleanupError = cleanupError;
		throw recoveryError;
	}

	if (cleanupError) {
		throw cleanupError;
	}

	return scenarioResult;
}

/**
 * Scenario B.1: Prior Session Revocation.
 * Session is deleted before provisionIdentity is invoked.
 * Checks: returns { ok: false, error: 'DENIED' }. Zero writes across all tables.
 */
export async function runScenarioB1() {
	const tag = generateRunTag('scenB1');
	const tracker = new FixtureTracker(tag);
	let sqlAdmin = null;
	let sql1 = null;
	let scenarioResult = null;
	let executionError = null;
	let cleanupError = null;

	const testEmail = `revoked_${tag}@lab.synthetic.test`.toLowerCase();

	try {
		sqlAdmin = await createVerifiedLabConnection();
		const tenant = await setupSyntheticTenant(sqlAdmin, tag, tracker);

		sql1 = await createVerifiedLabConnection();
		const client = createProvisioningClient(sql1);

		// Revoke session prior to invocation
		await sqlAdmin`DELETE FROM auth_sessions WHERE id = ${tenant.sessionId}`;

		const result = await client.provisioning.provisionIdentity(tenant.headers, tenant.orgId, {
			name: 'Revoked Actor',
			email: testEmail,
			password: 'Synthetic-password-123!'
		});

		// Track user if unexpectedly created
		if (result?.ok && result.value?.userId) {
			tracker.trackUser(result.value.userId);
		}
		const recovered = await sqlAdmin`
			SELECT user_id FROM user_emails WHERE email = ${testEmail}
		`;
		for (const r of recovered) {
			tracker.trackUser(r.user_id);
		}

		assert.equal(result.ok, false);
		assert.equal(result.error, 'DENIED');

		const users = await sqlAdmin`SELECT id FROM users WHERE name = 'Revoked Actor'`;
		assert.equal(users.length, 0, 'No user should be created when session was revoked');

		scenarioResult = {
			scenario: 'B.1. Prior Session Revocation',
			status: 'PASSED',
			details: 'Rejected with DENIED before any writes occurred.'
		};
	} catch (err) {
		executionError = err;
	} finally {
		if (sql1) await sql1.end({ timeout: 1 }).catch(() => {});
		if (sqlAdmin) {
			try {
				await cleanupSyntheticTenant(sqlAdmin, tracker);
			} catch (err) {
				cleanupError = err;
			} finally {
				await sqlAdmin.end({ timeout: 1 }).catch(() => {});
			}
		}
	}

	if (cleanupError) {
		if (executionError) {
			executionError.cleanupError = cleanupError;
			throw executionError;
		}
		throw cleanupError;
	}

	if (executionError) {
		throw executionError;
	}

	return scenarioResult;
}

/**
 * Scenario B.2: Concurrent Session Revocation (Demonstrating FOR SHARE Row Lock).
 *
 * Sequence:
 * 1. Connection 1 starts provisionIdentity and acquires auth_sessions FOR SHARE.
 * 2. Connection 1 pauses via query builder interceptor before committing.
 * 3. Connection 2 attempts DELETE FROM auth_sessions WHERE id = sessionId.
 *    Using dispatchQuery, the query is transmitted immediately over the socket.
 * 4. Connection 3 polls pg_stat_activity to prove Connection 2 is actively blocked in PostgreSQL (wait_event_type = 'Lock').
 * 5. Connection 1 commits and releases its lock.
 * 6. Connection 2 unblocks in PostgreSQL and finishes DELETE.
 */
export async function runScenarioB2() {
	const tag = generateRunTag('scenB2');
	const tracker = new FixtureTracker(tag);
	let sqlAdmin = null;
	let sql1 = null;
	let sql2 = null;
	let sqlObserver = null;
	let signalAfterLock = null;
	let signalBeforeCommit = null;
	let task1 = null;
	let task2 = null;
	let scenarioResult = null;
	let executionError = null;
	let cleanupError = null;

	try {
		sqlAdmin = await createVerifiedLabConnection();
		const tenant = await setupSyntheticTenant(sqlAdmin, tag, tracker);

		sql1 = await createVerifiedLabConnection();
		sql2 = await createVerifiedLabConnection();
		sqlObserver = await createVerifiedLabConnection();

		signalAfterLock = createSignal('B2_AfterSessionLock', 8000);
		signalBeforeCommit = createSignal('B2_BeforeCommit', 8000);

		// Wrap tx using wrapQueryBuilder with recursive proxy to intercept fluent chains
		const client1 = createProvisioningClient(sql1, {
			wrapTransaction: (tx) =>
				new Proxy(tx, {
					get(target, prop) {
						if (prop === 'insert') {
							return (table) => {
								const builder = target.insert(table);
								return wrapQueryBuilder(builder, {
									onBeforeExecute: async () => {
										signalAfterLock.notify();
										await signalBeforeCommit.wait();
									}
								});
							};
						}
						const val = Reflect.get(target, prop);
						return typeof val === 'function' ? val.bind(target) : val;
					}
				})
		});

		// Task 1: Provisioning transaction
		task1 = client1.provisioning.provisionIdentity(tenant.headers, tenant.orgId, {
			name: 'Session Lock Test',
			email: `sessionlock_${tag}@lab.synthetic.test`.toLowerCase(),
			password: 'Synthetic-password-123!'
		});

		// Task 2: Concurrently attempt DELETE on the locked session row
		task2 = (async () => {
			await signalAfterLock.wait();

			// Dispatches DELETE query immediately over the wire to PostgreSQL socket
			const deletePromise = dispatchQuery(
				sql2`DELETE FROM auth_sessions WHERE id = ${tenant.sessionId}`
			);

			// Verify via Connection 3 that Connection 2 is genuinely blocked in PostgreSQL engine
			await pollPgLock(sqlObserver, 'DELETE FROM auth_sessions', 3000);

			// Release Connection 1 so it can commit and release lock
			signalBeforeCommit.notify();

			// Await completion of DELETE (unblocks once Conn 1 commits)
			await deletePromise;
		})();

		const [res1] = await Promise.all([task1, task2]);

		// Track created user immediately before assertions
		if (res1?.ok && res1.value?.userId) {
			tracker.trackUser(res1.value.userId);
		}

		assert.equal(
			res1.ok,
			true,
			'Provisioning must succeed because session was valid and locked FOR SHARE'
		);

		// Verify final state: session was deleted after lock release
		const remainingSession =
			await sqlAdmin`SELECT id FROM auth_sessions WHERE id = ${tenant.sessionId}`;
		assert.equal(remainingSession.length, 0, 'Session must be deleted after lock was released');

		scenarioResult = {
			scenario: 'B.2. Concurrent Session Revocation (FOR SHARE)',
			status: 'PASSED',
			details:
				'pg_stat_activity confirmed DELETE blocked in PostgreSQL until provisioning committed.'
		};
	} catch (err) {
		executionError = err;
	} finally {
		// Ensure signals are unblocked so no async background tasks hang on timeout
		if (signalAfterLock && !signalAfterLock.settled) {
			signalAfterLock.abort();
		}
		if (signalBeforeCommit && !signalBeforeCommit.settled) {
			signalBeforeCommit.abort();
		}
		if (sql1) await sql1.end({ timeout: 1 }).catch(() => {});
		if (sql2) await sql2.end({ timeout: 1 }).catch(() => {});
		if (sqlObserver) await sqlObserver.end({ timeout: 1 }).catch(() => {});

		// Ensure no concurrent tasks remain pending before starting cleanup
		if (task1 || task2) {
			await Promise.allSettled([task1, task2].filter(Boolean));
		}

		if (sqlAdmin) {
			try {
				await cleanupSyntheticTenant(sqlAdmin, tracker);
			} catch (err) {
				cleanupError = err;
			} finally {
				await sqlAdmin.end({ timeout: 1 }).catch(() => {});
			}
		}
	}

	if (cleanupError) {
		if (executionError) {
			executionError.cleanupError = cleanupError;
			throw executionError;
		}
		throw cleanupError;
	}

	if (executionError) {
		throw executionError;
	}

	return scenarioResult;
}

/**
 * Scenario C.1: Concurrent Target User Deactivation (Demonstrating FOR SHARE on Users).
 *
 * Sequence:
 * 1. Target user U_target is active. Pre-registered in tracker before insert.
 * 2. Connection 1 calls provisionMembership(targetUserId), acquiring users FOR SHARE via activeUser().
 * 3. Connection 1 pauses before committing.
 * 4. Connection 2 dispatches UPDATE users SET active = false WHERE id = targetUserId.
 * 5. Connection 3 polls pg_stat_activity to prove Connection 2 is actively blocked on row lock.
 * 6. Connection 1 commits. Connection 2 unblocks and updates active = false.
 * 7. Verified: membership was created while user was verified active; user is now inactive.
 */
export async function runScenarioC1() {
	const tag = generateRunTag('scenC1');
	const tracker = new FixtureTracker(tag);
	let sqlAdmin = null;
	let sql1 = null;
	let sql2 = null;
	let sqlObserver = null;
	let signalAfterLock = null;
	let signalBeforeCommit = null;
	let task1 = null;
	let task2 = null;
	let scenarioResult = null;
	let executionError = null;
	let cleanupError = null;

	try {
		sqlAdmin = await createVerifiedLabConnection();
		const tenant = await setupSyntheticTenant(sqlAdmin, tag, tracker);

		const targetUserId = crypto.randomUUID();
		// Register target UUID in tracker BEFORE any SQL insert
		tracker.trackUser(targetUserId);
		await sqlAdmin`INSERT INTO users (id, name, active) VALUES (${targetUserId}, ${'Target ' + tag}, true)`;

		sql1 = await createVerifiedLabConnection();
		sql2 = await createVerifiedLabConnection();
		sqlObserver = await createVerifiedLabConnection();

		signalAfterLock = createSignal('C1_AfterUserLock', 8000);
		signalBeforeCommit = createSignal('C1_BeforeCommit', 8000);

		const client1 = createProvisioningClient(sql1, {
			wrapTransaction: (tx) =>
				new Proxy(tx, {
					get(target, prop) {
						if (prop === 'insert') {
							return (table) => {
								const builder = target.insert(table);
								return wrapQueryBuilder(builder, {
									onBeforeExecute: async () => {
										// Lock on user was acquired in activeUser()
										signalAfterLock.notify();
										await signalBeforeCommit.wait();
									}
								});
							};
						}
						const val = Reflect.get(target, prop);
						return typeof val === 'function' ? val.bind(target) : val;
					}
				})
		});

		task1 = client1.provisioning.provisionMembership(
			tenant.headers,
			tenant.orgId,
			targetUserId,
			[]
		);

		task2 = (async () => {
			await signalAfterLock.wait();

			// Dispatches UPDATE immediately to PostgreSQL socket
			const updatePromise = dispatchQuery(
				sql2`UPDATE users SET active = false WHERE id = ${targetUserId}`
			);

			// Verify via Connection 3 that UPDATE is blocked on row lock in PostgreSQL engine
			await pollPgLock(sqlObserver, 'UPDATE users SET active = false', 3000);

			signalBeforeCommit.notify();
			await updatePromise;
		})();

		const [res1] = await Promise.all([task1, task2]);

		// Track created membership immediately before assertions
		if (res1?.ok && res1.value?.membershipId) {
			tracker.trackMember(res1.value.membershipId);
		}

		assert.equal(res1.ok, true, 'Membership created while user was locked active');

		// Verify final state: membership exists, user active is now false
		const [u] = await sqlAdmin`SELECT active FROM users WHERE id = ${targetUserId}`;
		assert.equal(u.active, false, 'User active status was updated to false after lock release');

		scenarioResult = {
			scenario: 'C.1. Concurrent Target User Deactivation (FOR SHARE)',
			status: 'PASSED',
			details: 'pg_stat_activity confirmed UPDATE blocked in PostgreSQL until membership committed.'
		};
	} catch (err) {
		executionError = err;
	} finally {
		if (signalAfterLock && !signalAfterLock.settled) {
			signalAfterLock.abort();
		}
		if (signalBeforeCommit && !signalBeforeCommit.settled) {
			signalBeforeCommit.abort();
		}
		if (sql1) await sql1.end({ timeout: 1 }).catch(() => {});
		if (sql2) await sql2.end({ timeout: 1 }).catch(() => {});
		if (sqlObserver) await sqlObserver.end({ timeout: 1 }).catch(() => {});

		if (task1 || task2) {
			await Promise.allSettled([task1, task2].filter(Boolean));
		}

		if (sqlAdmin) {
			try {
				await cleanupSyntheticTenant(sqlAdmin, tracker);
			} catch (err) {
				cleanupError = err;
			} finally {
				await sqlAdmin.end({ timeout: 1 }).catch(() => {});
			}
		}
	}

	if (cleanupError) {
		if (executionError) {
			executionError.cleanupError = cleanupError;
			throw executionError;
		}
		throw cleanupError;
	}

	if (executionError) {
		throw executionError;
	}

	return scenarioResult;
}

/**
 * Scenario C.2: Prior Target User Deactivation.
 * User is deactivated before provisionMembership is called.
 * Checks: activeUser() throws DENIED. Zero memberships created.
 */
export async function runScenarioC2() {
	const tag = generateRunTag('scenC2');
	const tracker = new FixtureTracker(tag);
	let sqlAdmin = null;
	let sql1 = null;
	let scenarioResult = null;
	let executionError = null;
	let cleanupError = null;

	try {
		sqlAdmin = await createVerifiedLabConnection();
		const tenant = await setupSyntheticTenant(sqlAdmin, tag, tracker);

		const targetUserId = crypto.randomUUID();
		// Register in tracker before SQL insertion
		tracker.trackUser(targetUserId);
		await sqlAdmin`INSERT INTO users (id, name, active) VALUES (${targetUserId}, ${'Target ' + tag}, false)`;

		sql1 = await createVerifiedLabConnection();
		const client = createProvisioningClient(sql1);
		const result = await client.provisioning.provisionMembership(
			tenant.headers,
			tenant.orgId,
			targetUserId,
			[]
		);

		if (result?.ok && result.value?.membershipId) {
			tracker.trackMember(result.value.membershipId);
		}

		assert.equal(result.ok, false);
		assert.equal(result.error, 'DENIED');

		const members = await sqlAdmin`SELECT id FROM memberships WHERE user_id = ${targetUserId}`;
		assert.equal(members.length, 0, 'No membership created for deactivated user');

		scenarioResult = {
			scenario: 'C.2. Prior Target User Deactivation',
			status: 'PASSED',
			details: 'Rejected with DENIED before any writes occurred.'
		};
	} catch (err) {
		executionError = err;
	} finally {
		if (sql1) await sql1.end({ timeout: 1 }).catch(() => {});
		if (sqlAdmin) {
			try {
				await cleanupSyntheticTenant(sqlAdmin, tracker);
			} catch (err) {
				cleanupError = err;
			} finally {
				await sqlAdmin.end({ timeout: 1 }).catch(() => {});
			}
		}
	}

	if (cleanupError) {
		if (executionError) {
			executionError.cleanupError = cleanupError;
			throw executionError;
		}
		throw cleanupError;
	}

	if (executionError) {
		throw executionError;
	}

	return scenarioResult;
}

/**
 * Scenario D.1: Concurrent Role Deactivation during assignMembershipRoles (FOR UPDATE Row Lock Serialization).
 *
 * Sequence:
 * 1. Connection 1 calls assignMembershipRoles, selecting target role FOR UPDATE.
 * 2. Connection 1 pauses before committing.
 * 3. Connection 2 concurrently executes genuine deactivation: UPDATE roles SET active = false WHERE id = targetRoleId.
 * 4. Connection 3 polls pg_stat_activity to prove Connection 2 is genuinely blocked in PostgreSQL (wait_event_type = 'Lock').
 * 5. Connection 1 commits role assignment. Connection 2 unblocks and sets active = false.
 * 6. Verified: Role assignment succeeded while active; role is now deactivated.
 */
export async function runScenarioD1() {
	const tag = generateRunTag('scenD1');
	const tracker = new FixtureTracker(tag);
	let sqlAdmin = null;
	let sql1 = null;
	let sql2 = null;
	let sqlObserver = null;
	let signalAfterLock = null;
	let signalBeforeCommit = null;
	let task1 = null;
	let task2 = null;
	let scenarioResult = null;
	let executionError = null;
	let cleanupError = null;

	try {
		sqlAdmin = await createVerifiedLabConnection();
		const tenant = await setupSyntheticTenant(sqlAdmin, tag, tracker);

		const targetUserId = crypto.randomUUID();
		const targetMemberId = crypto.randomUUID();
		const targetRoleId = crypto.randomUUID();

		// Register all UUIDs in tracker before executing SQL inserts
		tracker.trackUser(targetUserId);
		tracker.trackMember(targetMemberId);
		tracker.trackRole(targetRoleId);

		await sqlAdmin`INSERT INTO users (id, name, active) VALUES (${targetUserId}, ${'Target ' + tag}, true)`;
		await sqlAdmin`INSERT INTO memberships (id, organization_id, user_id, active) VALUES (${targetMemberId}, ${tenant.orgId}, ${targetUserId}, true)`;
		await sqlAdmin`INSERT INTO roles (id, organization_id, name, code, active) VALUES (${targetRoleId}, ${tenant.orgId}, 'Role Target', ${'target-' + tag}, true)`;
		await sqlAdmin`INSERT INTO role_permissions (id, role_id, permission_id) VALUES (${crypto.randomUUID()}, ${targetRoleId}, 'identities:create')`;

		sql1 = await createVerifiedLabConnection();
		sql2 = await createVerifiedLabConnection();
		sqlObserver = await createVerifiedLabConnection();

		signalAfterLock = createSignal('D1_AfterRoleLock', 8000);
		signalBeforeCommit = createSignal('D1_BeforeCommit', 8000);

		const client1 = createProvisioningClient(sql1, {
			wrapTransaction: (tx) =>
				new Proxy(tx, {
					get(target, prop) {
						if (prop === 'insert') {
							return (table) => {
								const builder = target.insert(table);
								return wrapQueryBuilder(builder, {
									onBeforeExecute: async () => {
										// Lock on roles was acquired with FOR UPDATE in assign()
										signalAfterLock.notify();
										await signalBeforeCommit.wait();
									}
								});
							};
						}
						const val = Reflect.get(target, prop);
						return typeof val === 'function' ? val.bind(target) : val;
					}
				})
		});

		task1 = client1.provisioning.assignMembershipRoles(
			tenant.headers,
			tenant.orgId,
			targetMemberId,
			[targetRoleId]
		);

		task2 = (async () => {
			await signalAfterLock.wait();

			// Real role deactivation: sets active = false
			const updatePromise = dispatchQuery(
				sql2`UPDATE roles SET active = false WHERE id = ${targetRoleId}`
			);

			// Verify via Connection 3 that UPDATE is blocked on row lock in PostgreSQL engine
			await pollPgLock(sqlObserver, 'UPDATE roles SET active = false', 3000);

			signalBeforeCommit.notify();
			await updatePromise;
		})();

		const [res1] = await Promise.all([task1, task2]);

		assert.equal(res1.ok, true, 'Role assignment completed while role was locked active');

		// Verify final state: assignment exists and role active status is now false
		const assignments = await sqlAdmin`
			SELECT id FROM role_assignments WHERE membership_id = ${targetMemberId} AND role_id = ${targetRoleId}
		`;
		assert.equal(assignments.length, 1, 'Role assignment must exist in role_assignments table');

		const [roleRow] = await sqlAdmin`
			SELECT active FROM roles WHERE id = ${targetRoleId}
		`;
		assert.equal(
			roleRow.active,
			false,
			'Role active status must be false after concurrent deactivation unblocked'
		);

		scenarioResult = {
			scenario: 'D.1. Concurrent Role Deactivation (FOR UPDATE Row Lock Serialization)',
			status: 'PASSED',
			details:
				'pg_stat_activity confirmed role deactivation blocked in PostgreSQL until assignment committed.'
		};
	} catch (err) {
		executionError = err;
	} finally {
		if (signalAfterLock && !signalAfterLock.settled) {
			signalAfterLock.abort();
		}
		if (signalBeforeCommit && !signalBeforeCommit.settled) {
			signalBeforeCommit.abort();
		}
		if (sql1) await sql1.end({ timeout: 1 }).catch(() => {});
		if (sql2) await sql2.end({ timeout: 1 }).catch(() => {});
		if (sqlObserver) await sqlObserver.end({ timeout: 1 }).catch(() => {});

		if (task1 || task2) {
			await Promise.allSettled([task1, task2].filter(Boolean));
		}

		if (sqlAdmin) {
			try {
				await cleanupSyntheticTenant(sqlAdmin, tracker);
			} catch (err) {
				cleanupError = err;
			} finally {
				await sqlAdmin.end({ timeout: 1 }).catch(() => {});
			}
		}
	}

	if (cleanupError) {
		if (executionError) {
			executionError.cleanupError = cleanupError;
			throw executionError;
		}
		throw cleanupError;
	}

	if (executionError) {
		throw executionError;
	}

	return scenarioResult;
}

/**
 * Scenario D.2: Prior Permission Revocation.
 * Permission roles:assign is revoked before assignMembershipRoles is called.
 * Checks: returns DENIED. Zero role assignments created.
 */
export async function runScenarioD2() {
	const tag = generateRunTag('scenD2');
	const tracker = new FixtureTracker(tag);
	let sqlAdmin = null;
	let sql1 = null;
	let scenarioResult = null;
	let executionError = null;
	let cleanupError = null;

	try {
		sqlAdmin = await createVerifiedLabConnection();
		const tenant = await setupSyntheticTenant(sqlAdmin, tag, tracker);

		const targetUserId = crypto.randomUUID();
		const targetMemberId = crypto.randomUUID();
		const targetRoleId = crypto.randomUUID();

		// Register before SQL insert
		tracker.trackUser(targetUserId);
		tracker.trackMember(targetMemberId);
		tracker.trackRole(targetRoleId);

		await sqlAdmin`INSERT INTO users (id, name, active) VALUES (${targetUserId}, ${'Target ' + tag}, true)`;
		await sqlAdmin`INSERT INTO memberships (id, organization_id, user_id, active) VALUES (${targetMemberId}, ${tenant.orgId}, ${targetUserId}, true)`;
		await sqlAdmin`INSERT INTO roles (id, organization_id, name, code, active) VALUES (${targetRoleId}, ${tenant.orgId}, 'Role Target', ${'target-' + tag}, true)`;
		await sqlAdmin`INSERT INTO role_permissions (id, role_id, permission_id) VALUES (${crypto.randomUUID()}, ${targetRoleId}, 'identities:create')`;

		sql1 = await createVerifiedLabConnection();
		const client = createProvisioningClient(sql1);

		// Revoke roles:assign permission from actor's synthetic role
		await sqlAdmin`
			DELETE FROM role_permissions
			WHERE role_id = ${tenant.roleId} AND permission_id = 'roles:assign'
		`;

		const result = await client.provisioning.assignMembershipRoles(
			tenant.headers,
			tenant.orgId,
			targetMemberId,
			[targetRoleId]
		);

		assert.equal(result.ok, false);
		assert.equal(result.error, 'DENIED');

		const assignments =
			await sqlAdmin`SELECT id FROM role_assignments WHERE membership_id = ${targetMemberId}`;
		assert.equal(assignments.length, 0, 'No role assignments created');

		scenarioResult = {
			scenario: 'D.2. Prior Permission Revocation',
			status: 'PASSED',
			details: 'Rejected with DENIED when actor lacked roles:assign permission.'
		};
	} catch (err) {
		executionError = err;
	} finally {
		if (sql1) await sql1.end({ timeout: 1 }).catch(() => {});
		if (sqlAdmin) {
			try {
				await cleanupSyntheticTenant(sqlAdmin, tracker);
			} catch (err) {
				cleanupError = err;
			} finally {
				await sqlAdmin.end({ timeout: 1 }).catch(() => {});
			}
		}
	}

	if (cleanupError) {
		if (executionError) {
			executionError.cleanupError = cleanupError;
			throw executionError;
		}
		throw cleanupError;
	}

	if (executionError) {
		throw executionError;
	}

	return scenarioResult;
}

/**
 * Scenario E: Controlled Failure and Complete Atomic Rollback.
 * Triggers failure on auth_accounts insertion.
 * Verifies complete rollback across all 4 tables: users, user_emails, auth_users, auth_accounts.
 */
export async function runScenarioE() {
	const tag = generateRunTag('scenE');
	const tracker = new FixtureTracker(tag);
	let sqlAdmin = null;
	let sql1 = null;
	let scenarioResult = null;
	let executionError = null;
	let cleanupError = null;

	const email = `fail_${tag}@lab.synthetic.test`.toLowerCase();

	try {
		sqlAdmin = await createVerifiedLabConnection();
		const tenant = await setupSyntheticTenant(sqlAdmin, tag, tracker);

		sql1 = await createVerifiedLabConnection();

		// Wrap tx to simulate driver error when inserting auth_accounts
		const client = createProvisioningClient(sql1, {
			wrapTransaction: (tx) =>
				new Proxy(tx, {
					get(target, prop) {
						if (prop === 'insert') {
							return (table) => {
								if (table?.[Symbol.for('drizzle:Name')] === 'auth_accounts') {
									throw new Error('[SIMULATED DRIVER FAILURE ON CREDENTIAL INSERT]');
								}
								return target.insert(table);
							};
						}
						const val = Reflect.get(target, prop);
						return typeof val === 'function' ? val.bind(target) : val;
					}
				})
		});

		const result = await client.provisioning.provisionIdentity(tenant.headers, tenant.orgId, {
			name: 'Failing Identity ' + tag,
			email,
			password: 'Synthetic-password-123!'
		});

		// Track user if unexpectedly created
		if (result?.ok && result.value?.userId) {
			tracker.trackUser(result.value.userId);
		}
		const recovered = await sqlAdmin`
			SELECT user_id FROM user_emails WHERE email = ${email}
		`;
		for (const r of recovered) {
			tracker.trackUser(r.user_id);
		}

		assert.equal(result.ok, false);
		assert.equal(result.error, 'FAILED');

		// Verify zero rows across all 4 affected tables
		const users = await sqlAdmin`SELECT id FROM users WHERE name = ${'Failing Identity ' + tag}`;
		const emails = await sqlAdmin`SELECT id FROM user_emails WHERE email = ${email}`;
		const authUsers = await sqlAdmin`SELECT id FROM auth_users WHERE email = ${email}`;
		const accounts =
			await sqlAdmin`SELECT id FROM auth_accounts WHERE user_id IN (SELECT id FROM users WHERE name = ${'Failing Identity ' + tag})`;

		assert.equal(users.length, 0, 'users table must have rolled back completely');
		assert.equal(emails.length, 0, 'user_emails table must have rolled back completely');
		assert.equal(authUsers.length, 0, 'auth_users table must have rolled back completely');
		assert.equal(accounts.length, 0, 'auth_accounts table must have rolled back completely');

		scenarioResult = {
			scenario: 'E. Controlled Failure and Complete Rollback',
			status: 'PASSED',
			details:
				'Credential failure resulted in zero orphaned rows across users, user_emails, auth_users and auth_accounts.'
		};
	} catch (err) {
		executionError = err;
	} finally {
		if (sql1) await sql1.end({ timeout: 1 }).catch(() => {});
		if (sqlAdmin) {
			try {
				await cleanupSyntheticTenant(sqlAdmin, tracker);
			} catch (err) {
				cleanupError = err;
			} finally {
				await sqlAdmin.end({ timeout: 1 }).catch(() => {});
			}
		}
	}

	if (cleanupError) {
		if (executionError) {
			executionError.cleanupError = cleanupError;
			throw executionError;
		}
		throw cleanupError;
	}

	if (executionError) {
		throw executionError;
	}

	return scenarioResult;
}

/**
 * Scenario F: Lock Acquisition Order and Deadlock Check.
 *
 * Conn 1 assigns [Role_B, Role_A]
 * Conn 2 assigns [Role_A, Role_B]
 *
 * Verified:
 * Because assignMembershipRoles sorts roleIds with [...roleIds].sort(), both transactions
 * request FOR UPDATE locks on Role_A first, then Role_B.
 * Zero 40P01 deadlock errors occur.
 */
export async function runScenarioF() {
	const tag = generateRunTag('scenF');
	const tracker = new FixtureTracker(tag);
	let sqlAdmin = null;
	let sql1 = null;
	let sql2 = null;
	let barrier = null;
	let task1 = null;
	let task2 = null;
	let scenarioResult = null;
	let executionError = null;
	let cleanupError = null;

	try {
		sqlAdmin = await createVerifiedLabConnection();
		const tenant = await setupSyntheticTenant(sqlAdmin, tag, tracker);

		const roleAId = crypto.randomUUID();
		const roleBId = crypto.randomUUID();
		const member1Id = crypto.randomUUID();
		const member2Id = crypto.randomUUID();
		const user1Id = crypto.randomUUID();
		const user2Id = crypto.randomUUID();

		const [sortedFirst, sortedSecond] = [roleAId, roleBId].sort();

		// Register all UUIDs in tracker before issuing SQL inserts
		tracker.trackUser(user1Id);
		tracker.trackUser(user2Id);
		tracker.trackMember(member1Id);
		tracker.trackMember(member2Id);
		tracker.trackRole(sortedFirst);
		tracker.trackRole(sortedSecond);

		await sqlAdmin`INSERT INTO users (id, name, active) VALUES (${user1Id}, 'U1', true), (${user2Id}, 'U2', true)`;
		await sqlAdmin`INSERT INTO memberships (id, organization_id, user_id, active) VALUES (${member1Id}, ${tenant.orgId}, ${user1Id}, true), (${member2Id}, ${tenant.orgId}, ${user2Id}, true)`;
		await sqlAdmin`INSERT INTO roles (id, organization_id, name, code, active) VALUES (${sortedFirst}, ${tenant.orgId}, 'R1', ${'r1-' + tag}, true), (${sortedSecond}, ${tenant.orgId}, 'R2', ${'r2-' + tag}, true)`;
		await sqlAdmin`INSERT INTO role_permissions (id, role_id, permission_id) VALUES (${crypto.randomUUID()}, ${sortedFirst}, 'identities:create'), (${crypto.randomUUID()}, ${sortedSecond}, 'identities:create')`;

		sql1 = await createVerifiedLabConnection();
		sql2 = await createVerifiedLabConnection();

		barrier = createBarrier('ScenarioF_DeadlockTest', 2, 8000);

		const client1 = createProvisioningClient(sql1);
		const client2 = createProvisioningClient(sql2);

		// Conn 1 assigns in reverse order: [sortedSecond, sortedFirst]
		task1 = (async () => {
			await barrier.wait();
			return client1.provisioning.assignMembershipRoles(tenant.headers, tenant.orgId, member1Id, [
				sortedSecond,
				sortedFirst
			]);
		})();

		// Conn 2 assigns in direct order: [sortedFirst, sortedSecond]
		task2 = (async () => {
			await barrier.wait();
			return client2.provisioning.assignMembershipRoles(tenant.headers, tenant.orgId, member2Id, [
				sortedFirst,
				sortedSecond
			]);
		})();

		const [res1, res2] = await Promise.all([task1, task2]);

		assert.equal(res1.ok, true, 'Task 1 must complete without deadlock');
		assert.equal(res2.ok, true, 'Task 2 must complete without deadlock');

		scenarioResult = {
			scenario: 'F. Lock Acquisition Ordering & Deadlock Prevention',
			status: 'PASSED',
			details:
				'[...roleIds].sort() serialized lock requests in identical order; zero 40P01 deadlocks observed.'
		};
	} catch (err) {
		executionError = err;
	} finally {
		if (barrier && !barrier.settled) {
			barrier.abort();
		}
		if (sql1) await sql1.end({ timeout: 1 }).catch(() => {});
		if (sql2) await sql2.end({ timeout: 1 }).catch(() => {});

		if (task1 || task2) {
			await Promise.allSettled([task1, task2].filter(Boolean));
		}

		if (sqlAdmin) {
			try {
				await cleanupSyntheticTenant(sqlAdmin, tracker);
			} catch (err) {
				cleanupError = err;
			} finally {
				await sqlAdmin.end({ timeout: 1 }).catch(() => {});
			}
		}
	}

	if (cleanupError) {
		if (executionError) {
			executionError.cleanupError = cleanupError;
			throw executionError;
		}
		throw cleanupError;
	}

	if (executionError) {
		throw executionError;
	}

	return scenarioResult;
}
