import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { fixture, createCredentialUser } from './helpers/auth-fixture.mjs';

/**
 * 5.4X-C — invitation email outbox with one-time encrypted tokens (option 1). Synthetic keys and
 * addresses only.
 */
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const MIN = 60_000;

test('SoporteFlow — Etapa 5.4X-C: outbox de invitaciones', async (t) => {
	const previousLevel = process.env.LOG_LEVEL;
	const f = await fixture(t);
	process.env.LOG_LEVEL = 'debug';
	t.after(() => {
		if (previousLevel === undefined) delete process.env.LOG_LEVEL;
		else process.env.LOG_LEVEL = previousLevel;
	});
	const { db, schema: s, server } = f;
	const load = (p) => server.ssrLoadModule(p);
	const outbox = await load('/src/lib/server/services/invitation-deliveries.ts');
	const crypto = await load('/src/lib/server/invitations/token-crypto.ts');
	const invitationsService = await load('/src/lib/server/services/invitations.ts');
	const acceptance = await load('/src/lib/server/services/invitation-acceptance.ts');
	const email = await load('/src/lib/server/email/invitation-email.ts');
	const logging = await load('/src/lib/server/logging/logger.ts');
	const { validateServerEnvironment, ServerConfigurationError } = await load(
		'/src/lib/server/config/env.ts'
	);
	const { ensureOrganizationRoles } = await load('/src/lib/server/services/roles.ts');
	const { PERMISSION_IDS } = await load('/src/lib/server/auth/permissions.ts');
	const KEY = randomBytes(32);

	const raw = [];
	logging.setLogSink((line) => raw.push(line));
	t.after(() => logging.setLogSink(undefined));

	async function organization(name) {
		const [org] = await db
			.insert(s.organizations)
			.values({ name, slug: 'xo-' + randomUUID(), status: 'active' })
			.returning();
		const { roles } = await ensureOrganizationRoles(db, org.id);
		const admin = await createCredentialUser(f, { email: `xo-admin-${randomUUID()}@example.test` });
		await db.insert(s.memberships).values({ organizationId: org.id, userId: admin.id });
		return { org, admin, customer: roles.find((r) => r.code === 'customer') };
	}
	const A = await organization('Outbox A');
	const B = await organization('Outbox B');
	const ctx = (o) => ({
		organizationId: o.org.id,
		actorUserId: o.admin.id,
		actorPermissions: PERMISSION_IDS
	});
	let seq = 0;
	const invite = (o = A, to = `xo-${++seq}-${randomUUID().slice(0, 6)}@example.test`) =>
		invitationsService.createInvitation(
			db,
			ctx(o),
			{ email: to, roleId: o.customer.id },
			{ encryptionKey: KEY }
		);
	const deliveriesOf = (invitationId) =>
		db
			.select()
			.from(s.invitationDeliveries)
			.where(eq(s.invitationDeliveries.invitationId, invitationId))
			.orderBy(s.invitationDeliveries.createdAt);
	const invitationRow = async (id) =>
		(await db.select().from(s.invitations).where(eq(s.invitations.id, id)))[0];
	/** Sender that records every attempt (token included) and follows a script of failures. */
	function recorder(...script) {
		const attempts = [];
		return {
			attempts,
			async sendInvitation(message) {
				attempts.push({ ...message });
				const next = script.shift();
				if (next) throw next;
			}
		};
	}
	let clock = Date.now() + MIN;
	const later = (ms = 10 * MIN) => new Date((clock += ms));
	const run = (sender, extra = {}) =>
		outbox.processDueInvitationDeliveries(db, {
			sender,
			encryptionKey: KEY,
			now: later(),
			...extra
		});
	const assertNeutralized = (row) => {
		assert.equal(row.tokenCiphertext, null);
		assert.equal(row.tokenIv, null);
		assert.equal(row.tokenAuthTag, null);
		assert.equal(row.nextAttemptAt, null);
		assert.equal(row.leaseToken, null);
	};

	await t.test(
		'1-2. creación atómica invitación + hash + delivery cifrada; rollback de ambos',
		async () => {
			const issued = await invite();
			const [delivery] = await deliveriesOf(issued.invitation.id);
			assert.equal(delivery.status, 'pending');
			assert.equal(delivery.organizationId, A.org.id);
			assert.ok(delivery.tokenCiphertext && delivery.tokenIv && delivery.tokenAuthTag);
			assert.equal(
				(await invitationRow(issued.invitation.id)).tokenHash,
				sha256(issued.delivery.token)
			);
			// rollback after issuing: neither the invitation nor its delivery survive
			const to = `rollback-${randomUUID()}@example.test`;
			await assert.rejects(
				db.transaction(async (tx) => {
					await invitationsService.createInvitation(
						tx,
						ctx(A),
						{ email: to, roleId: A.customer.id },
						{ encryptionKey: KEY }
					);
					throw new Error('rollback');
				}),
				/rollback/
			);
			assert.equal(
				(await db.select().from(s.invitations).where(eq(s.invitations.email, to))).length,
				0
			);
			// missing key: fail closed before writing anything (no invitation without delivery)
			const saved = process.env.INVITATION_TOKEN_ENCRYPTION_KEY;
			delete process.env.INVITATION_TOKEN_ENCRYPTION_KEY;
			try {
				const before = (await db.select().from(s.invitations)).length;
				await assert.rejects(
					invitationsService.createInvitation(db, ctx(A), {
						email: `nokey-${randomUUID()}@example.test`,
						roleId: A.customer.id
					}),
					(e) => e.code === 'INVITATION_DELIVERY_NOT_CONFIGURED'
				);
				assert.equal((await db.select().from(s.invitations)).length, before);
			} finally {
				process.env.INVITATION_TOKEN_ENCRYPTION_KEY = saved;
			}
		}
	);

	await t.test('3-4. ciphertext ≠ plaintext; descifra solo con clave y AAD correctas', async () => {
		const issued = await invite();
		const token = issued.delivery.token;
		const [d] = await deliveriesOf(issued.invitation.id);
		const dump = JSON.stringify(d);
		assert.ok(!dump.includes(token));
		assert.notEqual(Buffer.from(d.tokenCiphertext, 'base64').toString('utf8'), token);
		assert.equal(Buffer.from(d.tokenIv, 'base64').length, 12);
		assert.equal(Buffer.from(d.tokenAuthTag, 'base64').length, 16);
		const stored = { ciphertext: d.tokenCiphertext, iv: d.tokenIv, authTag: d.tokenAuthTag };
		const binding = { invitationId: d.invitationId, deliveryId: d.id };
		assert.equal(crypto.decryptInvitationToken(KEY, stored, binding), token);
		const reject = (fn) => assert.throws(fn, (e) => e.name === 'InvitationTokenConfigurationError');
		reject(() => crypto.decryptInvitationToken(randomBytes(32), stored, binding));
		reject(() =>
			crypto.decryptInvitationToken(KEY, stored, { ...binding, deliveryId: randomUUID() })
		);
		reject(() =>
			crypto.decryptInvitationToken(KEY, stored, { ...binding, invitationId: randomUUID() })
		);
		const tag = Buffer.from(stored.authTag, 'base64');
		tag[0] ^= 0xff;
		reject(() =>
			crypto.decryptInvitationToken(KEY, { ...stored, authTag: tag.toString('base64') }, binding)
		);
		// fresh IV per encryption: same token, same binding -> different ciphertexts
		const a = crypto.encryptInvitationToken(KEY, token, binding);
		const b = crypto.encryptInvitationToken(KEY, token, binding);
		assert.notEqual(a.iv, b.iv);
		assert.notEqual(a.ciphertext, b.ciphertext);
		for (const bad of ['', 'short', 'zz'.repeat(32), randomBytes(16).toString('hex')])
			assert.throws(() => crypto.parseInvitationTokenKey(bad));
	});

	await t.test(
		'5, 8. reintentos reutilizan el mismo enlace; éxito neutraliza el ciphertext',
		async () => {
			await run(recorder()); // drain previous cases
			const issued = await invite();
			const [before] = await deliveriesOf(issued.invitation.id);
			const sender = recorder(
				new email.InvitationEmailError('NETWORK_ERROR'),
				new email.EmailDeliveryError()
			);
			assert.equal((await run(sender)).retried, 1);
			const [afterFirst] = await deliveriesOf(issued.invitation.id);
			assert.equal(afterFirst.status, 'retry');
			assert.equal(
				afterFirst.tokenCiphertext,
				before.tokenCiphertext,
				'mismo material en reintento'
			);
			assert.equal(afterFirst.lastErrorCode, 'NETWORK_ERROR');
			assert.equal((await run(sender)).retried, 1);
			assert.equal((await run(sender)).sent, 1);
			assert.equal(sender.attempts.length, 3);
			assert.deepEqual(
				[...new Set(sender.attempts.map((m) => m.token))],
				[issued.delivery.token],
				'los tres intentos llevan el mismo enlace'
			);
			const [sent] = await deliveriesOf(issued.invitation.id);
			assert.equal(sent.status, 'sent');
			assert.equal(sent.attemptCount, 3);
			assertNeutralized(sent);
		}
	);

	await t.test(
		'6-7. reenvío manual: token nuevo, delivery nueva, token anterior inválido',
		async () => {
			const issued = await invite();
			const oldToken = issued.delivery.token;
			const resent = await invitationsService.resendInvitation(db, ctx(A), issued.invitation.id, {
				encryptionKey: KEY
			});
			assert.notEqual(resent.delivery.token, oldToken);
			const [oldDelivery, newDelivery] = await deliveriesOf(issued.invitation.id);
			assert.equal(oldDelivery.status, 'cancelled');
			assert.equal(oldDelivery.lastErrorCode, 'SUPERSEDED');
			assertNeutralized(oldDelivery);
			assert.equal(newDelivery.status, 'pending');
			const sender = recorder();
			await run(sender);
			const mine = sender.attempts.filter((m) => m.email === issued.delivery.email);
			assert.deepEqual(
				mine.map((m) => m.token),
				[resent.delivery.token],
				'solo el enlace nuevo sale'
			);
			await assert.rejects(
				acceptance.verifyInvitationToken(db, oldToken),
				(e) => e.code === 'INVALID_INVITATION'
			);
			assert.equal(
				(await acceptance.verifyInvitationToken(db, resent.delivery.token)).roleName,
				'Cliente'
			);
			// at most one active delivery per invitation (DB)
			await assert.rejects(
				db.insert(s.invitationDeliveries).values(
					[0, 1].map(() => {
						const id = randomUUID();
						const enc = crypto.encryptInvitationToken(KEY, 't', {
							invitationId: issued.invitation.id,
							deliveryId: id
						});
						return {
							id,
							organizationId: A.org.id,
							invitationId: issued.invitation.id,
							tokenCiphertext: enc.ciphertext,
							tokenIv: enc.iv,
							tokenAuthTag: enc.authTag
						};
					})
				)
			);
		}
	);

	await t.test(
		'9. terminal/agotada: ciphertext neutralizado (transitorios, permanente, lease caducado)',
		async () => {
			await run(recorder());
			// exhausted after transient failures
			const exhausted = await invite();
			await db
				.update(s.invitationDeliveries)
				.set({ attemptCount: outbox.INVITATION_DELIVERY_MAX_ATTEMPTS - 1 })
				.where(eq(s.invitationDeliveries.invitationId, exhausted.invitation.id));
			assert.equal((await run(recorder(new email.InvitationEmailError('RATE_LIMITED')))).failed, 1);
			const [e] = await deliveriesOf(exhausted.invitation.id);
			assert.equal(e.status, 'failed');
			assert.equal(e.lastErrorCode, 'MAX_ATTEMPTS');
			assertNeutralized(e);
			// permanent failure (no provider)
			const permanent = await invite();
			assert.equal((await run(new email.UnconfiguredInvitationEmailSender())).failed, 1);
			const [p] = await deliveriesOf(permanent.invitation.id);
			assert.equal(p.lastErrorCode, 'PROVIDER_NOT_CONFIGURED');
			assertNeutralized(p);
			assert.equal(
				(await invitationRow(permanent.invitation.id)).status,
				'pending',
				'la invitación sigue reenviable'
			);
			// worker died holding the last attempt: closed by the next claim, neutralized
			const orphan = await invite();
			await db
				.update(s.invitationDeliveries)
				.set({
					status: 'processing',
					leaseToken: randomUUID(),
					attemptCount: outbox.INVITATION_DELIVERY_MAX_ATTEMPTS,
					nextAttemptAt: new Date(clock)
				})
				.where(eq(s.invitationDeliveries.invitationId, orphan.invitation.id));
			await run(recorder());
			const [o] = await deliveriesOf(orphan.invitation.id);
			assert.equal(o.status, 'failed');
			assertNeutralized(o);
			// the DB itself refuses a terminal row that still holds token material
			const [fresh] = await deliveriesOf((await invite()).invitation.id);
			await assert.rejects(
				db
					.update(s.invitationDeliveries)
					.set({ status: 'sent', nextAttemptAt: null })
					.where(eq(s.invitationDeliveries.id, fresh.id))
			);
		}
	);

	await t.test(
		'10. revocación, aceptación y expiración neutralizan entregas pendientes',
		async () => {
			await run(recorder());
			const revoked = await invite();
			await invitationsService.revokeInvitation(db, A.org.id, revoked.invitation.id);
			const accepted = await invite();
			await acceptance.acceptInvitation(db, {
				token: accepted.delivery.token,
				principalUserId: null,
				name: 'Aceptada',
				password: 'Very-Long-Password-xo-1'
			});
			const expired = await invite();
			await db
				.update(s.invitations)
				.set({ expiresAt: new Date(Date.now() - 1000) })
				.where(eq(s.invitations.id, expired.invitation.id));
			const [r] = await deliveriesOf(revoked.invitation.id);
			const [a] = await deliveriesOf(accepted.invitation.id);
			assert.equal(r.status, 'cancelled');
			assert.equal(r.lastErrorCode, 'INVITATION_REVOKED');
			assertNeutralized(r);
			assert.equal(a.status, 'cancelled');
			assert.equal(a.lastErrorCode, 'INVITATION_ACCEPTED');
			assertNeutralized(a);
			const sender = recorder();
			const result = await run(sender);
			assert.equal(result.cancelled, 1, 'la expirada se cancela en el envío');
			assert.equal(sender.attempts.length, 0, 'ningún envío útil');
			const [x] = await deliveriesOf(expired.invitation.id);
			assert.equal(x.lastErrorCode, 'INVITATION_EXPIRED');
			assertNeutralized(x);
		}
	);

	await t.test(
		'11. recuperación tras caída del worker: reclamada tras el lease, mismo enlace',
		async () => {
			await run(recorder());
			const issued = await invite();
			const now = later();
			const claimed = await outbox.claimDueInvitationDeliveries(db, { now });
			assert.equal(claimed.length, 1);
			// crash: no outcome written; the row keeps its lease and its ciphertext
			const [stuck] = await deliveriesOf(issued.invitation.id);
			assert.equal(stuck.status, 'processing');
			assert.ok(stuck.tokenCiphertext);
			// before the lease expires nobody can take it
			const early = recorder();
			assert.equal(
				(
					await outbox.processDueInvitationDeliveries(db, {
						sender: early,
						encryptionKey: KEY,
						now: new Date(now.getTime() + MIN)
					})
				).claimed,
				0
			);
			const sender = recorder();
			const result = await outbox.processDueInvitationDeliveries(db, {
				sender,
				encryptionKey: KEY,
				now: new Date(now.getTime() + outbox.INVITATION_DELIVERY_LEASE_MS + 1000)
			});
			assert.equal(result.sent, 1);
			assert.equal(sender.attempts[0].token, issued.delivery.token);
			const [done] = await deliveriesOf(issued.invitation.id);
			assert.equal(done.attemptCount, 2);
			assertNeutralized(done);
			// the crashed worker's late outcome is rejected by the lease guard
			assert.equal(
				(
					await db
						.update(s.invitationDeliveries)
						.set({ status: 'retry' })
						.where(
							and(
								eq(s.invitationDeliveries.id, done.id),
								eq(s.invitationDeliveries.leaseToken, claimed[0].leaseToken)
							)
						)
						.returning()
				).length,
				0
			);
		}
	);

	await t.test('12. workers concurrentes: cada entrega exactamente una vez', async () => {
		await run(recorder());
		const issued = await Promise.all(Array.from({ length: 8 }, () => invite()));
		const sender = recorder();
		const now = later();
		const results = await Promise.all(
			[0, 1, 2].map(() =>
				outbox.processDueInvitationDeliveries(db, { sender, encryptionKey: KEY, now, limit: 3 })
			)
		);
		const again = await outbox.processDueInvitationDeliveries(db, {
			sender,
			encryptionKey: KEY,
			now,
			limit: 100
		});
		const sent = results.reduce((n, r) => n + r.sent, 0) + again.sent;
		assert.equal(sent, 8);
		const tokens = sender.attempts.map((m) => m.token);
		assert.equal(new Set(tokens).size, 8, 'sin duplicados');
		assert.deepEqual([...tokens].sort(), issued.map((i) => i.delivery.token).sort());
	});

	await t.test('13. el token, el ciphertext y el destinatario nunca aparecen en logs', async () => {
		raw.length = 0;
		logging.resetLogThrottles();
		const issued = await invite();
		const [d] = await deliveriesOf(issued.invitation.id);
		await run(
			recorder(
				new email.InvitationEmailError('PROVIDER_ERROR', `smtp rejected ${issued.delivery.token}`)
			)
		);
		await run(recorder(), { encryptionKey: randomBytes(32) }); // wrong key -> CONFIGURATION_ERROR retry
		await run(recorder());
		const text = raw.join('\n');
		assert.ok(
			text.includes('invitation_email.delivery_retry'),
			`hay trazabilidad: ${raw.map((l) => JSON.parse(l).event).join(',')}`
		);
		for (const leak of [
			issued.delivery.token,
			d.tokenCiphertext,
			issued.delivery.email,
			KEY.toString('hex')
		])
			assert.ok(!text.includes(leak), 'fuga en logs');
	});

	await t.test('14. aislamiento entre tenants', async () => {
		const inA = await invite(A);
		const inB = await invite(B);
		// cancelling with the wrong tenant touches nothing
		assert.equal(
			await db.transaction((tx) =>
				outbox.cancelInvitationDeliveries(tx, B.org.id, inA.invitation.id, 'INVITATION_REVOKED')
			),
			0
		);
		assert.equal((await deliveriesOf(inA.invitation.id))[0].status, 'pending');
		// composite FK: a delivery can never point to another tenant's invitation
		const id = randomUUID();
		const enc = crypto.encryptInvitationToken(KEY, 'x', {
			invitationId: inA.invitation.id,
			deliveryId: id
		});
		await assert.rejects(
			db.insert(s.invitationDeliveries).values({
				id,
				organizationId: B.org.id,
				invitationId: inA.invitation.id,
				tokenCiphertext: enc.ciphertext,
				tokenIv: enc.iv,
				tokenAuthTag: enc.authTag
			})
		);
		// a ciphertext moved to another tenant's row does not decrypt (AAD binding)
		const [dA] = await deliveriesOf(inA.invitation.id);
		const [dB] = await deliveriesOf(inB.invitation.id);
		assert.throws(() =>
			crypto.decryptInvitationToken(
				KEY,
				{ ciphertext: dA.tokenCiphertext, iv: dA.tokenIv, authTag: dA.tokenAuthTag },
				{ invitationId: dB.invitationId, deliveryId: dB.id }
			)
		);
		const sender = recorder();
		await run(sender);
		for (const m of sender.attempts)
			assert.ok([A.org.name, B.org.name].includes(m.organizationName));
		assert.equal(
			sender.attempts.find((m) => m.email === inA.delivery.email).organizationName,
			A.org.name
		);
	});

	await t.test(
		'config: clave independiente, exacta, sin fallback y obligatoria en producción',
		() => {
			const base = {
				NODE_ENV: 'production',
				BETTER_AUTH_ENABLED: 'true',
				BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
				BETTER_AUTH_URL: 'https://support.example.com',
				DATABASE_URL: 'postgresql://app:pw@db.internal/sf'
			};
			const hex = randomBytes(32).toString('hex');
			const issues = (env) => {
				try {
					validateServerEnvironment(env, { development: false });
					return [];
				} catch (error) {
					assert.ok(error instanceof ServerConfigurationError);
					assert.ok(!error.message.includes(hex), 'nunca el valor');
					return error.issues.map((i) => `${i.variable} ${i.problem}`);
				}
			};
			assert.deepEqual(issues(base), ['INVITATION_TOKEN_ENCRYPTION_KEY is missing']);
			assert.deepEqual(issues({ ...base, INVITATION_TOKEN_ENCRYPTION_KEY: hex }), []);
			assert.deepEqual(
				issues({
					...base,
					INVITATION_TOKEN_ENCRYPTION_KEY: hex,
					WEBHOOK_SECRET_ENCRYPTION_KEY: hex
				}),
				['INVITATION_TOKEN_ENCRYPTION_KEY must be independent of WEBHOOK_SECRET_ENCRYPTION_KEY']
			);
			for (const bad of [
				'00'.repeat(32),
				randomBytes(16).toString('hex'),
				randomBytes(33).toString('hex'),
				'not-a-key'
			])
				assert.equal(issues({ ...base, INVITATION_TOKEN_ENCRYPTION_KEY: bad }).length, 1, bad);
			assert.equal(
				validateServerEnvironment(
					{ ...base, INVITATION_TOKEN_ENCRYPTION_KEY: hex },
					{ development: false }
				).invitationTokenEncryption,
				'configured'
			);
		}
	);
});
