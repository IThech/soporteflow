import { eq } from 'drizzle-orm';
import { organizations } from '../db/schema';
import { organizationGrantsInTransaction } from './authorization';
import { organizationScopedPermissions } from './effective-permissions';
import type { AuthTransaction } from './instance';
import type { PermissionId } from './permissions';

/**
 * 5.4W-A (H1, confirmed on real PostgreSQL): an administrative request used to be authorized
 * (session, membership, permissions, delegation snapshot) BEFORE its service transaction. A
 * concurrent transaction could demote the actor in between, and the mutation then committed with
 * stale authority.
 *
 * withActorAuthorization runs the whole mutation in ONE transaction that:
 * 1. locks the organization row first — the same lock every administrative change takes, so the
 *    order is always organization -> actor rows -> resource rows (no new lock cycles);
 *    `update` for mutations whose service locks the organization FOR UPDATE (role, membership,
 *    invitation, SLA policy, automation rule changes), `share` for the rest (they must not
 *    upgrade a lock later: that could deadlock two concurrent requests);
 * 2. re-validates the actor inside that transaction (authorizeActionInTransaction), after the
 *    lock, so a demotion that committed while this request waited is always seen;
 * 3. runs the mutation on the same transaction with the actor's CURRENT capabilities (the value
 *    to use for monotonic delegation — never a snapshot taken before the transaction).
 * Fails closed with ActorAuthorizationError (HTTP 403) and nothing is written.
 */
export class ActorAuthorizationError extends Error {
	readonly code = 'ACTOR_NOT_AUTHORIZED';
	constructor() {
		super('ACTOR_NOT_AUTHORIZED');
		this.name = 'ActorAuthorizationError';
	}
}

export function isActorAuthorizationError(error: unknown): error is ActorAuthorizationError {
	return (
		error instanceof ActorAuthorizationError ||
		(error as { name?: unknown } | null)?.name === 'ActorAuthorizationError'
	);
}

export interface ActorAuthorizationContext {
	/** Principal resolved by the HTTP layer from the session (never from input). */
	userId: string;
	organizationId: string;
	/** Every permission the mutation requires (all must be held at organization scope). */
	permissionIds: readonly PermissionId[];
	/** Organization row lock mode; must match the service's own organization lock. */
	lock: 'share' | 'update';
}

/**
 * Re-validation primitive: the actor's CURRENT organization-scoped capabilities read on `tx`, or
 * null (fail closed) if any required permission is missing or the membership/user/organization is
 * no longer active. Call it after the lock that serializes the mutation.
 */
export async function authorizeActionInTransaction(
	tx: AuthTransaction,
	action: Readonly<{
		userId: string;
		organizationId: string;
		permissionIds: readonly PermissionId[];
	}>
): Promise<PermissionId[] | null> {
	if (!action || !Array.isArray(action.permissionIds) || action.permissionIds.length === 0)
		return null;
	const grants = await organizationGrantsInTransaction(tx, action.userId, action.organizationId);
	if (!grants) return null;
	const current = organizationScopedPermissions(grants);
	return action.permissionIds.every((id) => current.includes(id)) ? current : null;
}

type TransactionalDb = { transaction: <T>(run: (tx: AuthTransaction) => Promise<T>) => Promise<T> };

export async function withActorAuthorization<T>(
	db: TransactionalDb,
	context: ActorAuthorizationContext,
	run: (tx: AuthTransaction, actorPermissions: readonly PermissionId[]) => Promise<T>
): Promise<T> {
	return db.transaction(async (tx) => {
		const [org] = await tx
			.select({ id: organizations.id })
			.from(organizations)
			.where(eq(organizations.id, context.organizationId))
			.limit(1)
			.for(context.lock);
		if (!org) throw new ActorAuthorizationError();
		const actorPermissions = await authorizeActionInTransaction(tx, {
			userId: context.userId,
			organizationId: context.organizationId,
			permissionIds: context.permissionIds
		});
		if (!actorPermissions) throw new ActorAuthorizationError();
		return run(tx, actorPermissions);
	});
}
