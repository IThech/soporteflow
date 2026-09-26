import { json } from '@sveltejs/kit';
import { authorizeAction } from './authorization';
import { incidentAccessAllows, type IncidentAccess } from '../services/incidents';

/**
 * Single source of incident read access for HTTP endpoints (5.4N-0, extended in 5.4S-B).
 * Runtime capabilities only (authorizeAction: active user, active membership, active
 * organization, active roles; never role codes or names). Precedence:
 * - incidents:view_all                        -> { viewAll: true } (dominates everything else);
 * - incidents:view_own + incidents:view_requested
 *                                             -> { assignedToUserId, clientUserId } (UNION: OR);
 * - incidents:view_own                        -> { assignedToUserId: principal } (staff scope);
 * - incidents:view_requested                  -> { clientUserId: principal } (requester scope);
 * - none                                      -> null (no access).
 * Requester ownership is exclusively incidents.client_user_id: createdByUserId and the legacy
 * client text never grant access. The returned restriction must be enforced against the
 * incident itself (services do it under the incident row lock, lists in SQL).
 */
export async function resolveIncidentAccess(
	headers: Headers,
	organizationId: string,
	principalUserId: string
): Promise<IncidentAccess | null> {
	if (await authorizeAction(headers, { organizationId, permissionId: 'incidents:view_all' }))
		return { viewAll: true };
	const own = await authorizeAction(headers, {
		organizationId,
		permissionId: 'incidents:view_own'
	});
	const requested = await authorizeAction(headers, {
		organizationId,
		permissionId: 'incidents:view_requested'
	});
	if (!own && !requested) return null;
	return {
		...(own ? { assignedToUserId: principalUserId } : {}),
		...(requested ? { clientUserId: principalUserId } : {})
	};
}

/**
 * Access scope for incident mutations (edit, assign, site, category, support level).
 * The requester scope (view_requested) grants reading and public comments only: it never widens
 * what an actor holding incidents:edit / incidents:assign may change, so it is dropped here.
 */
export async function resolveIncidentMutationAccess(
	headers: Headers,
	organizationId: string,
	principalUserId: string
): Promise<IncidentAccess | null> {
	const access = await resolveIncidentAccess(headers, organizationId, principalUserId);
	if (!access || access.viewAll === true) return access;
	return access.assignedToUserId !== undefined
		? { assignedToUserId: access.assignedToUserId }
		: null;
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
 * Shared HTTP mapping for incident mutation errors: access denied -> 403 (the incident exists
 * in the caller's own tenant; cross-tenant ids already surface as 404), closed -> 409.
 * Returns null for codes the endpoint maps itself.
 */
export function incidentMutationFailure(code: string): Response | null {
	if (DENIED_CODES.has(code))
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
