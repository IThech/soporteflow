import { json } from '@sveltejs/kit';
import { resolveEffectivePermissions } from './effective-permissions';
import { ActorAuthorizationError, withActorAuthorization } from './transactional-authorization';
import type { AuthTransaction } from './instance';
import type { PermissionId } from './permissions';
import { incidentAccessAllows, type IncidentAccess } from '../services/incidents';

/**
 * Single source of incident access (5.4N-0, 5.4S-B; unified in 5.4W-B).
 *
 * Every decision is derived from the caller's CURRENT organization-scoped capabilities by
 * incidentAccessFromPermissions, whether they were read before the transaction (reads) or inside
 * the mutation transaction (withIncidentActor). Precedence:
 * - incidents:view_all                        -> { viewAll: true } (dominates everything else);
 * - incidents:view_own + incidents:view_requested
 *                                             -> { assignedToUserId, clientUserId } (UNION: OR);
 * - incidents:view_own                        -> { assignedToUserId: principal } (staff scope);
 * - incidents:view_requested                  -> { clientUserId: principal } (requester scope);
 * - none                                      -> null (no access).
 * Requester ownership is exclusively incidents.client_user_id: createdByUserId and the legacy
 * client text never grant access. The restriction is enforced against the incident itself
 * (services under the incident row lock, lists in SQL) with the same OR semantics.
 */
export function incidentAccessFromPermissions(
	permissions: readonly string[],
	principalUserId: string
): IncidentAccess | null {
	if (permissions.includes('incidents:view_all')) return { viewAll: true };
	const own = permissions.includes('incidents:view_own');
	const requested = permissions.includes('incidents:view_requested');
	if (!own && !requested) return null;
	return {
		...(own ? { assignedToUserId: principalUserId } : {}),
		...(requested ? { clientUserId: principalUserId } : {})
	};
}

/**
 * Mutation scope (edit, assign, site, category, support level, SLA, internal notes): the requester
 * scope grants reading and public comments only, so it is dropped here.
 */
export function incidentMutationAccessFrom(access: IncidentAccess | null): IncidentAccess | null {
	if (!access || access.viewAll === true) return access;
	return access.assignedToUserId !== undefined
		? { assignedToUserId: access.assignedToUserId }
		: null;
}

/** Read access for HTTP reads (current capabilities; null when the organization is not accessible). */
export async function resolveIncidentAccess(
	headers: Headers,
	organizationId: string,
	principalUserId: string
): Promise<IncidentAccess | null> {
	const permissions = await resolveEffectivePermissions(headers, organizationId);
	return permissions ? incidentAccessFromPermissions(permissions, principalUserId) : null;
}

/** Pre-check form of the mutation scope (the authoritative one is computed in the transaction). */
export async function resolveIncidentMutationAccess(
	headers: Headers,
	organizationId: string,
	principalUserId: string
): Promise<IncidentAccess | null> {
	return incidentMutationAccessFrom(
		await resolveIncidentAccess(headers, organizationId, principalUserId)
	);
}

/**
 * Restriction fields for the incident-messages service contexts: none for view_all, otherwise
 * the restrictions held (the service applies them with the same OR semantics).
 */
export function incidentAccessRestriction(access: IncidentAccess): {
	assignedToUserId?: string;
	clientUserId?: string;
} {
	if (access.viewAll === true) return {};
	return {
		...(access.assignedToUserId !== undefined ? { assignedToUserId: access.assignedToUserId } : {}),
		...(access.clientUserId !== undefined ? { clientUserId: access.clientUserId } : {})
	};
}

/**
 * 5.4W-B: who is reading an incident. 'staff' when the caller sees it through view_all or as its
 * assignee (view_own); 'requester' when it is visible ONLY through the requester scope — that
 * audience receives the customer projection (no assignment, team, support level, SLA or other
 * internal data). A caller with both scopes is staff only for incidents assigned to them.
 */
export type IncidentAudience = 'staff' | 'requester';
export function incidentAudience(
	access: IncidentAccess | null,
	incident: { assignedToUserId: string | null }
): IncidentAudience {
	if (!access) return 'requester';
	if (access.viewAll === true) return 'staff';
	return access.assignedToUserId !== undefined &&
		incident.assignedToUserId === access.assignedToUserId
		? 'staff'
		: 'requester';
}

export interface IncidentActorScope {
	/** Read scope from the capabilities re-read inside the transaction (null: no read access). */
	read: IncidentAccess | null;
	/** Mutation scope (requester scope dropped). */
	mutation: IncidentAccess | null;
	/** Current organization-scoped capabilities (canonical ids). */
	permissions: readonly PermissionId[];
}

/**
 * 5.4W-B: incident mutations (create, edit, assign, site, category, support level, SLA, public
 * comments, internal notes) run in ONE transaction that locks the organization row FOR SHARE,
 * re-validates the actor's capabilities there (withActorAuthorization, 5.4W-A) and derives the
 * incident scopes from them. The service then locks the incident row itself, so the order is
 * organization (share) -> actor rows (share) -> incident (update): a concurrent role change
 * (organization FOR UPDATE) is either fully before (and seen here) or waits for this mutation.
 * Throws ActorAuthorizationError (403) when a required permission was lost.
 */
export function withIncidentActor<T>(
	db: Parameters<typeof withActorAuthorization>[0],
	context: { userId: string; organizationId: string; permissionIds: readonly PermissionId[] },
	run: (tx: AuthTransaction, scope: IncidentActorScope) => Promise<T>
): Promise<T> {
	return withActorAuthorization(db, { ...context, lock: 'share' }, (tx, permissions) => {
		const read = incidentAccessFromPermissions(permissions, context.userId);
		return run(tx, { read, mutation: incidentMutationAccessFrom(read), permissions });
	});
}

/** Mutation scope or fail closed (403) when the re-validated capabilities no longer grant it. */
export function requireMutationScope(scope: IncidentActorScope): IncidentAccess {
	if (!scope.mutation) throw new ActorAuthorizationError();
	return scope.mutation;
}
export function requireReadScope(scope: IncidentActorScope): IncidentAccess {
	if (!scope.read) throw new ActorAuthorizationError();
	return scope.read;
}

const DENIED_CODES = new Set([
	'INCIDENT_ACCESS_DENIED',
	// Actor/tenant state can only change between authorization and the write: treat as denied.
	'ORGANIZATION_NOT_FOUND',
	'ORGANIZATION_NOT_OPERATIONAL',
	'CREATOR_MEMBERSHIP_NOT_FOUND',
	'CREATOR_MEMBERSHIP_INACTIVE',
	'CREATOR_USER_INACTIVE'
]);

/**
 * Shared HTTP mapping for incident mutation errors (5.4W-B policy):
 * - incident missing, in another tenant or outside the caller's READ scope -> 404 (mapped by the
 *   endpoint from INCIDENT_NOT_FOUND);
 * - visible but not mutable by the caller, or authority lost mid-request -> 403;
 * - closed -> 409.
 * Returns null for codes the endpoint maps itself.
 */
export function incidentMutationFailure(code: string): Response | null {
	if (DENIED_CODES.has(code) || code === 'ACTOR_NOT_AUTHORIZED')
		return json({ error: { code: 'FORBIDDEN', message: 'Permission denied.' } }, { status: 403 });
	if (code === 'INCIDENT_CLOSED')
		return json(
			{ error: { code: 'INCIDENT_CLOSED', message: 'La incidencia está cerrada.' } },
			{ status: 409 }
		);
	return null;
}

/** True when the resolved access allows reading this incident (view_all, or any branch held). */
export function canAccessIncident(
	access: IncidentAccess,
	incident: { assignedToUserId: string | null; clientUserId: string | null }
): boolean {
	return incidentAccessAllows(access, incident);
}
