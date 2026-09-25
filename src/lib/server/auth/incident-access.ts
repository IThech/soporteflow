import { json } from '@sveltejs/kit';
import { authorizeAction } from './authorization';
import type { IncidentAccess } from '../services/incidents';

/**
 * Single source of incident read access for HTTP endpoints (semantics fixed in 5.4N-0):
 * - incidents:view_all -> {} (any incident of the requested organization);
 * - incidents:view_own -> { assignedToUserId: principal } (only incidents assigned to them);
 * - neither            -> null (no access).
 * clientUserId and incident creation never grant access. The returned restriction must be
 * enforced against the incident itself (services do it under the incident row lock).
 */
export async function resolveIncidentAccess(
	headers: Headers,
	organizationId: string,
	principalUserId: string
): Promise<IncidentAccess | null> {
	if (await authorizeAction(headers, { organizationId, permissionId: 'incidents:view_all' }))
		return {};
	if (await authorizeAction(headers, { organizationId, permissionId: 'incidents:view_own' }))
		return { assignedToUserId: principalUserId };
	return null;
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

/** True when the resolved access allows reading this incident. */
export function canAccessIncident(
	access: IncidentAccess,
	incident: { assignedToUserId: string | null }
): boolean {
	return (
		access.assignedToUserId === undefined || incident.assignedToUserId === access.assignedToUserId
	);
}
