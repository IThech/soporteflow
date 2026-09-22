import crypto from 'node:crypto';

export const SYNTHETIC_SECRET =
	'synthetic-concurrency-lab-only-secret-0123456789abcdef0123456789abcdef';

export const REQUIRED_CATALOG_PERMISSIONS = Object.freeze([
	'identities:create',
	'memberships:create',
	'roles:assign'
]);

const TAG_REGEX = /^synlab_[a-zA-Z0-9]+_\d+_[0-9a-f]{8}$/;

/**
 * Generates a strictly validated synthetic run tag for isolating fixtures.
 * Format: synlab_<scenarioId>_<timestamp>_<randomHex>
 *
 * @param {string} scenarioId - Alphanumeric identifier of the scenario (e.g. 'scenA', 'scenB1')
 */
export function generateRunTag(scenarioId = 'default') {
	const cleanId = scenarioId.replace(/[^a-zA-Z0-9]/g, '');
	const rand = crypto.randomBytes(4).toString('hex');
	const tag = `synlab_${cleanId}_${Date.now()}_${rand}`;
	if (!TAG_REGEX.test(tag)) {
		throw new Error(`[FIXTURE ERROR] Generated tag '${tag}' failed validation.`);
	}
	return tag;
}

/**
 * Validates that a given tag strictly matches the expected synthetic format.
 * Throws immediately if invalid to prevent running against non-synthetic data.
 *
 * @param {string} tag
 */
export function validateRunTag(tag) {
	if (!tag || typeof tag !== 'string' || !TAG_REGEX.test(tag)) {
		throw new Error(
			`[LAB SAFETY] Refusing operation: Tag '${tag}' does not match required format 'synlab_<name>_<time>_<hex>'. Aborting.`
		);
	}
}

/**
 * Precise, in-memory tracker of all UUIDs created for a synthetic scenario run.
 * Pre-allocates and records identifiers before insertion to guarantee complete
 * transactional teardown even in case of assertion failure or early abort.
 */
export class FixtureTracker {
	constructor(tag) {
		this.tag = tag;
		this.orgId = null;
		this.actorUserId = null;
		this.actorEmailId = null;
		this.actorAuthUserId = null;
		this.actorAuthAccountId = null;
		this.actorMembershipId = null;
		this.actorRoleId = null;
		this.actorSessionId = null;
		this.provisionedUserIds = new Set();
		this.extraMemberIds = new Set();
		this.extraRoleIds = new Set();
	}

	trackUser(userId) {
		if (userId) this.provisionedUserIds.add(userId);
	}

	trackMember(memberId) {
		if (memberId) this.extraMemberIds.add(memberId);
	}

	trackRole(roleId) {
		if (roleId) this.extraRoleIds.add(roleId);
	}
}

/**
 * Sets up synthetic tenant fixtures atomically inside a PostgreSQL transaction.
 * All synthetic UUIDs are registered into the tracker BEFORE executing any SQL insert.
 * Checks via SELECT that global catalog permissions exist; NEVER inserts or modifies them.
 *
 * @param {import('postgres').Sql} sql - Verified lab connection
 * @param {string} tag - Strictly validated synthetic tag
 * @param {FixtureTracker} [existingTracker] - Optional pre-created tracker
 */
export async function setupSyntheticTenant(sql, tag, existingTracker = null) {
	validateRunTag(tag);
	const tracker = existingTracker || new FixtureTracker(tag);

	const orgId = crypto.randomUUID();
	const actorUserId = crypto.randomUUID();
	const actorEmailId = crypto.randomUUID();
	const actorAuthAccountId = crypto.randomUUID();
	const membershipId = crypto.randomUUID();
	const roleId = crypto.randomUUID();
	const sessionId = crypto.randomUUID();
	const sessionToken = crypto.randomUUID();

	const email = `actor_${tag}@lab.synthetic.test`.toLowerCase();

	// Register all synthetic IDs in tracker before executing any query
	// so cleanup can find them even if the transaction or subsequent steps fail
	tracker.orgId = orgId;
	tracker.actorUserId = actorUserId;
	tracker.actorEmailId = actorEmailId;
	tracker.actorAuthUserId = actorUserId;
	tracker.actorAuthAccountId = actorAuthAccountId;
	tracker.actorMembershipId = membershipId;
	tracker.actorRoleId = roleId;
	tracker.actorSessionId = sessionId;

	// Atomic transaction: all or nothing
	await sql.begin(async (tx) => {
		// 1. Check that required global catalog permissions exist (SELECT only; NEVER insert into permissions)
		const existingPermissions = await tx`
			SELECT id FROM permissions WHERE id = ANY(${REQUIRED_CATALOG_PERMISSIONS})
		`;
		const foundIds = new Set(existingPermissions.map((p) => p.id));
		const missing = REQUIRED_CATALOG_PERMISSIONS.filter((p) => !foundIds.has(p));
		if (missing.length > 0) {
			throw new Error(
				`[LAB FIXTURE ERROR] Permisos requeridos ausentes en el catálogo global: ${missing.join(', ')}. ` +
					`El laboratorio no inserta ni modifica permisos compartidos. Aplique las migraciones o seeds del catálogo antes de ejecutar.`
			);
		}

		// 2. Organization
		await tx`
			INSERT INTO organizations (id, name, slug, status)
			VALUES (${orgId}, ${'Org ' + tag}, ${'org-' + tag}, 'active')
		`;

		// 3. Actor Identity (users + user_emails)
		await tx`
			INSERT INTO users (id, name, display_name, active)
			VALUES (${actorUserId}, ${'Actor ' + tag}, 'Actor', true)
		`;
		await tx`
			INSERT INTO user_emails (id, user_id, email, is_primary)
			VALUES (${actorEmailId}, ${actorUserId}, ${email}, true)
		`;

		// 4. Better Auth Profile & Account
		await tx`
			INSERT INTO auth_users (id, name, email, email_verified)
			VALUES (${actorUserId}, ${'Actor ' + tag}, ${email}, true)
		`;
		await tx`
			INSERT INTO auth_accounts (id, user_id, account_id, provider_id, password)
			VALUES (${actorAuthAccountId}, ${actorUserId}, ${actorUserId}, 'credential', 'synthetic-hash-placeholder')
		`;

		// 5. Actor Membership
		await tx`
			INSERT INTO memberships (id, organization_id, user_id, active)
			VALUES (${membershipId}, ${orgId}, ${actorUserId}, true)
		`;

		// 6. Provisioning Role & Role Permissions (synthetic role, never modifies global permissions catalog)
		await tx`
			INSERT INTO roles (id, organization_id, name, code, active)
			VALUES (${roleId}, ${orgId}, ${'Admin ' + tag}, ${'role-' + tag}, true)
		`;

		for (const permId of REQUIRED_CATALOG_PERMISSIONS) {
			await tx`
				INSERT INTO role_permissions (id, role_id, permission_id)
				VALUES (${crypto.randomUUID()}, ${roleId}, ${permId})
			`;
		}

		// 7. Role Assignment
		await tx`
			INSERT INTO role_assignments (id, organization_id, membership_id, role_id, scope_type)
			VALUES (${crypto.randomUUID()}, ${orgId}, ${membershipId}, ${roleId}, 'organization')
		`;

		// 8. Active Session
		const expiresAt = new Date(Date.now() + 7200000);
		await tx`
			INSERT INTO auth_sessions (id, user_id, token, expires_at)
			VALUES (${sessionId}, ${actorUserId}, ${sessionToken}, ${expiresAt})
		`;
	});

	// Cookie signing compatible with Better Auth v1.7.5
	const signature = crypto
		.createHmac('sha256', SYNTHETIC_SECRET)
		.update(sessionToken)
		.digest('base64');
	const cookieValue = `${sessionToken}.${signature}`;
	const headers = new Headers({
		cookie: `__Secure-soporteflow-auth.session_token=${encodeURIComponent(cookieValue)}`
	});

	return {
		tag,
		tracker,
		orgId,
		actorUserId,
		membershipId,
		roleId,
		sessionId,
		sessionToken,
		headers
	};
}

/**
 * Robust, transactional cleanup of synthetic fixtures.
 * Only deletes rows matching the exact tracked UUIDs and verified tag.
 * Completely avoids touching any production, demo, or catalog data.
 * Detects and bubbles up errors; never silently ignores cleanup failures.
 *
 * @param {import('postgres').Sql} sql - Verified lab connection
 * @param {FixtureTracker} tracker - Populated tracker with recorded IDs
 */
export async function cleanupSyntheticTenant(sql, tracker) {
	if (!tracker || !(tracker instanceof FixtureTracker)) {
		throw new Error(`[LAB SAFETY] Refusing cleanup without a valid FixtureTracker instance.`);
	}

	validateRunTag(tracker.tag);

	const allUserIds = [tracker.actorUserId, ...tracker.provisionedUserIds].filter(Boolean);
	const allOrgIds = [tracker.orgId].filter(Boolean);
	const allRoleIds = [tracker.actorRoleId, ...tracker.extraRoleIds].filter(Boolean);
	const allMemberIds = [tracker.actorMembershipId, ...tracker.extraMemberIds].filter(Boolean);

	if (allUserIds.length === 0 && allOrgIds.length === 0) {
		return;
	}

	try {
		await sql.begin(async (tx) => {
			// 1. Delete sessions for all tracked users
			if (allUserIds.length > 0) {
				await tx`DELETE FROM auth_sessions WHERE user_id = ANY(${allUserIds})`;
			}

			// 2. Delete accounts for all tracked users
			if (allUserIds.length > 0) {
				await tx`DELETE FROM auth_accounts WHERE user_id = ANY(${allUserIds})`;
			}

			// 3. Delete auth_users for all tracked users (must precede users table due to FK)
			if (allUserIds.length > 0) {
				await tx`DELETE FROM auth_users WHERE id = ANY(${allUserIds})`;
			}

			// 4. Delete role_assignments
			if (allOrgIds.length > 0 || allMemberIds.length > 0) {
				await tx`DELETE FROM role_assignments WHERE organization_id = ANY(${allOrgIds}) OR membership_id = ANY(${allMemberIds})`;
			}

			// 5. Delete role_permissions for synthetic roles
			if (allRoleIds.length > 0) {
				await tx`DELETE FROM role_permissions WHERE role_id = ANY(${allRoleIds})`;
			}

			// 6. Delete roles
			if (allOrgIds.length > 0 || allRoleIds.length > 0) {
				await tx`DELETE FROM roles WHERE organization_id = ANY(${allOrgIds}) OR id = ANY(${allRoleIds})`;
			}

			// 7. Delete memberships
			if (allOrgIds.length > 0 || allMemberIds.length > 0) {
				await tx`DELETE FROM memberships WHERE organization_id = ANY(${allOrgIds}) OR id = ANY(${allMemberIds})`;
			}

			// 8. Delete organizations
			if (allOrgIds.length > 0) {
				await tx`DELETE FROM organizations WHERE id = ANY(${allOrgIds})`;
			}

			// 9. Delete user_emails for all tracked users
			if (allUserIds.length > 0) {
				await tx`DELETE FROM user_emails WHERE user_id = ANY(${allUserIds})`;
			}

			// 10. Delete users
			if (allUserIds.length > 0) {
				await tx`DELETE FROM users WHERE id = ANY(${allUserIds})`;
			}
		});
	} catch (cleanupErr) {
		// Communicate cleanup failure explicitly rather than swallowing it
		const err = new Error(
			`[CLEANUP ERROR] Failed cleaning synthetic fixtures for tag '${tracker.tag}': ${cleanupErr.message}`,
			{ cause: cleanupErr }
		);
		throw err;
	}
}
