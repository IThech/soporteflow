import { and, eq } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import { getDb } from '../db';
import type { AuthTransaction } from './instance';
import { authorizeTransaction } from './authorization';
import { resolveTransactionPrincipal } from './principal';
import {
	users,
	userEmails,
	authUsers,
	authAccounts,
	memberships,
	roles,
	rolePermissions,
	permissions
} from '../db/schema';

/** New catalog keys. No seeds, implicit grants or production insertion. */
export const provisioningPermissions = Object.freeze({
	identity: 'identities:create',
	membership: 'memberships:create',
	roles: 'roles:assign'
});
type Result<T> =
	{ ok: true; value: T } | { ok: false; error: 'DENIED' | 'INVALID_INPUT' | 'CONFLICT' | 'FAILED' };
class ProvisioningFailure extends Error {
	constructor(readonly code: 'DENIED' | 'INVALID_INPUT') {
		super(code);
	}
}
const id = (v: unknown): v is string =>
	typeof v === 'string' &&
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
function requireInput(condition: unknown): asserts condition {
	if (!condition) throw new ProvisioningFailure('INVALID_INPUT');
}
async function run<T>(
	headers: Headers,
	operation: (tx: AuthTransaction) => Promise<T>
): Promise<Result<T>> {
	try {
		return {
			ok: true,
			value: await getDb().transaction(async (tx) => {
				const value = await operation(tx);
				if (!(await resolveTransactionPrincipal(headers, tx)))
					throw new ProvisioningFailure('DENIED');
				return value;
			})
		};
	} catch (error) {
		if (error instanceof ProvisioningFailure) return { ok: false, error: error.code };
		// Drizzle wraps driver exceptions. Never expose messages, SQL or parameters.
		const e = error as { code?: string; cause?: { code?: string } } | null;
		return {
			ok: false,
			error: e?.code === '23505' || e?.cause?.code === '23505' ? 'CONFLICT' : 'FAILED'
		};
	}
}
async function authorize(headers: Headers, org: string, permission: string, tx: AuthTransaction) {
	requireInput(id(org));
	const allowed = await authorizeTransaction(headers, org, permission, tx);
	if (!allowed) throw new ProvisioningFailure('DENIED');
	return allowed;
}
async function activeUser(userId: string, tx: AuthTransaction) {
	requireInput(id(userId));
	const [user] = await tx
		.select({ id: users.id })
		.from(users)
		.where(and(eq(users.id, userId), eq(users.active, true)))
		.for('share');
	if (!user) throw new ProvisioningFailure('DENIED');
}
/** Internal primitive; only called for a newly inserted identity in its outer transaction. */
async function createCredential(tx: AuthTransaction, userId: string, password: string) {
	const hash = await hashPassword(password);
	await tx
		.insert(authAccounts)
		.values({ userId, accountId: userId, providerId: 'credential', password: hash });
}
/** Creates no membership, sessions, verified email or permissions. Existing identities are never adopted. */
export async function provisionIdentity(
	headers: Headers,
	organizationId: string,
	input: { name: string; email: string; password: string }
): Promise<Result<{ userId: string }>> {
	return run(headers, async (tx) => {
		await authorize(headers, organizationId, provisioningPermissions.identity, tx);
		requireInput(
			input &&
				typeof input.name === 'string' &&
				input.name.trim().length > 0 &&
				input.name.trim().length <= 255
		);
		requireInput(typeof input.email === 'string' && input.email.length <= 255);
		const email = input.email.trim().toLowerCase();
		requireInput(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
		requireInput(
			typeof input.password === 'string' &&
				input.password.length >= 12 &&
				input.password.length <= 128
		);
		const [user] = await tx
			.insert(users)
			.values({ name: input.name.trim() })
			.returning({ id: users.id });
		await tx.insert(userEmails).values({ userId: user.id, email, isPrimary: true });
		await tx
			.insert(authUsers)
			.values({ id: user.id, name: input.name.trim(), email, emailVerified: false });
		await createCredential(tx, user.id, input.password);
		return { userId: user.id };
	});
}
/** Only organization-scoped role delegation in this phase; no implicit scope widening. */
async function assign(
	tx: AuthTransaction,
	headers: Headers,
	organizationId: string,
	membershipId: string,
	roleIds: readonly string[]
) {
	requireInput(
		Array.isArray(roleIds) &&
			roleIds.length > 0 &&
			roleIds.length <= 50 &&
			roleIds.every(id) &&
			new Set(roleIds).size === roleIds.length
	);
	const allowed = await authorize(headers, organizationId, provisioningPermissions.roles, tx);
	const [member] = await tx
		.select({ userId: memberships.userId })
		.from(memberships)
		.where(
			and(
				eq(memberships.id, membershipId),
				eq(memberships.organizationId, organizationId),
				eq(memberships.active, true)
			)
		)
		.for('share');
	if (!member) throw new ProvisioningFailure('DENIED');
	await activeUser(member.userId, tx);
	for (const roleId of [...roleIds].sort()) {
		const [role] = await tx
			.select({ id: roles.id })
			.from(roles)
			.where(
				and(eq(roles.id, roleId), eq(roles.organizationId, organizationId), eq(roles.active, true))
			)
			.for('update');
		if (!role) throw new ProvisioningFailure('DENIED');
		const grants = await tx
			.select({ id: permissions.id, scopes: permissions.allowedScopeTypes })
			.from(rolePermissions)
			.innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
			.where(eq(rolePermissions.roleId, roleId))
			.for('share');
		if (
			!grants.length ||
			grants.some(
				(p) =>
					p.id.startsWith('platform:') ||
					!p.scopes.includes('organization') ||
					!allowed.permissions.some((g) => g.permissionId === p.id && g.scope === 'organization')
			)
		)
			throw new ProvisioningFailure('DENIED');
		await tx
			.insert(roleAssignments)
			.values({ organizationId, membershipId, roleId, scopeType: 'organization' });
	}
}
import { roleAssignments } from '../db/schema';
/** Existing identity must be selected by UUID, never looked up or linked by email. */
export async function provisionMembership(
	headers: Headers,
	organizationId: string,
	userId: string,
	roleIds: readonly string[] = []
): Promise<Result<{ membershipId: string }>> {
	return run(headers, async (tx) => {
		await authorize(headers, organizationId, provisioningPermissions.membership, tx);
		await activeUser(userId, tx);
		requireInput(Array.isArray(roleIds));
		const [member] = await tx
			.insert(memberships)
			.values({ organizationId, userId })
			.returning({ id: memberships.id });
		if (roleIds.length) await assign(tx, headers, organizationId, member.id, roleIds);
		return { membershipId: member.id };
	});
}
export async function assignMembershipRoles(
	headers: Headers,
	organizationId: string,
	membershipId: string,
	roleIds: readonly string[]
): Promise<Result<{ membershipId: string }>> {
	return run(headers, async (tx) => {
		requireInput(id(membershipId));
		await assign(tx, headers, organizationId, membershipId, roleIds);
		return { membershipId };
	});
}
