import type { IncidentQueue } from '../api/incidents.ts';

/**
 * Capability-driven UI rules (UI-1A/1B, FE-02, FE-05).
 *
 * The UI is NOT an authority: these helpers only decide what to show. Every endpoint still
 * authorizes on the server. Rules use the real capabilities returned by
 * /api/me?organizationId=… (never role codes, never demo permissions).
 */

export type Capabilities = readonly string[];

export const INCIDENT_READ_CAPABILITIES = [
	'incidents:view_all',
	'incidents:view_own',
	'incidents:view_requested'
] as const;

/** Capabilities that make the (future, UI-3) administration area relevant. */
export const ADMIN_CAPABILITIES = [
	'roles:view',
	'memberships:view',
	'invitations:view',
	'sites:manage',
	'categories:manage',
	'sla:manage',
	'webhooks:view',
	'automations:view',
	'audit:view',
	'clients:manage',
	'clients:view'
] as const;

const has = (caps: Capabilities, id: string) => caps.includes(id);

export interface IncidentReadScope {
	viewAll: boolean;
	viewOwn: boolean;
	viewRequested: boolean;
	/** At least one read scope: the incidents area is usable. */
	any: boolean;
	/** Requester-only (customer): the server applies its scope; no explicit queue. */
	requesterOnly: boolean;
}

export function incidentReadScope(caps: Capabilities): IncidentReadScope {
	const viewAll = has(caps, 'incidents:view_all');
	const viewOwn = has(caps, 'incidents:view_own');
	const viewRequested = has(caps, 'incidents:view_requested');
	return {
		viewAll,
		viewOwn,
		viewRequested,
		any: viewAll || viewOwn || viewRequested,
		requesterOnly: viewRequested && !viewAll && !viewOwn
	};
}

/**
 * Queues the server actually authorizes (GET /api/incidents):
 * - `all` / `unassigned`: incidents:view_all only;
 * - `mine`: incidents:view_own OR incidents:view_all (the server accepts both: a view_all
 *   technician still needs "my incidents").
 * A requester-only user gets no explicit queue (the server returns exactly its scope).
 * Order is the display order.
 */
export function availableQueues(caps: Capabilities): IncidentQueue[] {
	const scope = incidentReadScope(caps);
	const queues: IncidentQueue[] = [];
	if (scope.viewAll) queues.push('all');
	if (scope.viewAll || scope.viewOwn) queues.push('mine');
	if (scope.viewAll) queues.push('unassigned');
	return queues;
}

/**
 * Default queue (documented rule):
 * 1. view_all                -> `all` (triage view for support/administration);
 * 2. view_own (no view_all)  -> `mine` (the only queue the server allows);
 * 3. requester only          -> null (no queue parameter: the server applies the scope);
 * 4. no read scope           -> null (the incidents area is not shown).
 * Never "all for everybody": `all` is only chosen when view_all is present.
 */
export function defaultQueue(caps: Capabilities): IncidentQueue | null {
	const scope = incidentReadScope(caps);
	if (scope.viewAll) return 'all';
	if (scope.viewOwn) return 'mine';
	return null;
}

/** A queue from the URL is honored only if it is available; otherwise the default applies. */
export function resolveQueue(requested: string | null, caps: Capabilities): IncidentQueue | null {
	const queues = availableQueues(caps);
	if (requested && (queues as string[]).includes(requested)) return requested as IncidentQueue;
	return defaultQueue(caps);
}

export interface NavigationModel {
	incidents: boolean;
	newIncident: boolean;
	/** Some admin capability exists; the admin area itself arrives in UI-3 (no dead link now). */
	adminCapable: boolean;
	adminClients?: boolean;
}

export function navigationModel(caps: Capabilities): NavigationModel {
	const model: NavigationModel = {
		incidents: incidentReadScope(caps).any,
		newIncident: has(caps, 'incidents:create'),
		adminCapable: ADMIN_CAPABILITIES.some((id) => has(caps, id))
	};
	if (has(caps, 'clients:manage')) {
		model.adminClients = true;
	}
	return model;
}
