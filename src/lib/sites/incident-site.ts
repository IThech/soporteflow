import { canActOnIncident } from '$lib/auth/record-access';
import { incidentOrganizationId } from '$lib/incidents/assignment';
import type { Incident } from '$lib/types/incident';
import type { IncidentHistoryEntry } from '$lib/types/incident-history';
import type { Site } from '$lib/types/site';
import type { AppUser } from '$lib/types/user';
import { generateId } from '$lib/utils/id';

export interface ChangeIncidentSiteInput {
	targetSiteId: string | null;
	reason?: string;
	comment?: string;
}

export interface ChangeIncidentSiteResult {
	incident: Incident;
	event: IncidentHistoryEntry;
}

/**
 * Validates and executes an explicit site change on an incident.
 *
 * Requirements:
 * - Actor must have 'incidents:edit' permission and access to the incident's organization.
 * - Target site (if specified) must exist, belong to the incident's organization, and be active.
 * - If targetSiteId is identical to current siteId, returns null (no change).
 * - Generates a 'site_changed' history event.
 * - DOES NOT alter supportLevel, teamId, assignedToUserId, status, SLA, or trigger re-routing.
 */
/**
 * Validates a site for an incident against an organization and available sites catalog.
 * Returns the matched Site if valid, or null if siteId is null/empty.
 * Throws an Error with domain-specific message if the site does not exist,
 * belongs to another organization, or is inactive.
 */
export function validateIncidentSite(
	siteId: string | null | undefined,
	organizationId: string,
	availableSites: readonly Site[] = []
): Site | null {
	const normalizedId = siteId?.trim() ? siteId.trim() : null;
	if (normalizedId === null) {
		return null;
	}

	const targetSite = availableSites.find((s) => s.id === normalizedId);
	if (!targetSite) {
		throw new Error('La sede seleccionada no existe.');
	}
	if (targetSite.organizationId !== organizationId) {
		throw new Error('La sede debe pertenecer a la misma organización que la incidencia.');
	}
	if (!targetSite.active) {
		throw new Error('No se puede asignar una sede inactiva a una incidencia.');
	}

	return targetSite;
}

export function changeIncidentSite(
	actor: AppUser,
	incident: Incident,
	input: ChangeIncidentSiteInput,
	availableSites: readonly Site[] = []
): ChangeIncidentSiteResult | null {
	if (!canActOnIncident(actor, incident, 'incidents:edit')) {
		throw new Error('No tienes permisos para modificar la sede de esta incidencia.');
	}

	const orgId = incidentOrganizationId(incident);
	const normalizedTargetId = input.targetSiteId?.trim() ? input.targetSiteId.trim() : null;
	const currentSiteId = incident.siteId ?? null;

	if (normalizedTargetId === currentSiteId) {
		return null;
	}

	validateIncidentSite(normalizedTargetId, orgId, availableSites);

	const timestamp = new Date().toISOString();
	const cleanReason = input.reason?.trim();
	const cleanComment = input.comment?.trim();

	const updatedIncident: Incident = {
		...incident,
		siteId: normalizedTargetId,
		updatedAt: timestamp
	};

	const event: IncidentHistoryEntry = {
		id: generateId(),
		incidentId: incident.id,
		organizationId: orgId,
		actorUserId: actor.id,
		timestamp,
		eventType: 'site_changed',
		previousValue: currentSiteId,
		newValue: normalizedTargetId,
		...(cleanReason ? { reason: cleanReason } : {}),
		...(cleanComment ? { comment: cleanComment } : {})
	};

	return {
		incident: updatedIncident,
		event
	};
}
