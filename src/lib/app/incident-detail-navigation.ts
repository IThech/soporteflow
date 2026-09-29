/**
 * UI-2C — navigation targets of /app/incidents/[id] (plain functions the page executes).
 * The list and creation paths are shared with UI-2B (incident-create-navigation.ts).
 */
import { incidentDetailPath, incidentListPath } from './incident-create-navigation.ts';

export { incidentDetailPath, incidentListPath };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A route param that can name an incident (anything else is "not available" without a request). */
export function isIncidentRouteId(value: string | undefined | null): value is string {
	return typeof value === 'string' && UUID.test(value);
}

/**
 * Organization switch from a detail: ALWAYS the list of the new organization. The incident id is
 * never carried to another tenant (it would ask organization B about an id of organization A).
 */
export function organizationSwitchTarget(organizationId: string): `/app/incidents?${string}` {
	return incidentListPath(organizationId);
}
