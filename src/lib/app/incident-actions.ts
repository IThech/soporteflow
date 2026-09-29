import { ApiError } from '../api/errors.ts';
import type { IncidentDetailView } from '../api/incident-detail.ts';
import type { IncidentPriority, IncidentStatus } from '../api/incident-views.ts';

/**
 * UI-2A — which incident controls the frontend may OFFER. This is not authorization: the server
 * re-validates capabilities and scope on every request (a hidden control is only a hint).
 *
 * Rules mirror the backend (src/routes/api/incidents/[id]/**, services/incidents.ts):
 * - staff mutation scope = the incident is seen with `audience: 'staff'` (the server computes the
 *   audience from the same scope: view_all, or view_own as its assignee). A requester projection
 *   never offers staff actions, whatever capabilities the user holds elsewhere;
 * - status / priority / support level / site / category: incidents:edit + staff scope;
 * - assignment: incidents:assign + staff scope;       SLA: sla:assign + staff scope;
 * - public comments: readable with the incident; writing needs incidents:add_comment (a requester
 *   may comment on their own incident);
 * - internal notes: reading needs incidents:view_internal_notes + staff scope; writing needs
 *   incidents:add_internal_note + staff scope — two independent capabilities;
 * - closed incidents are read-only: the only accepted change is the reopen `{ status: 'open' }`
 *   (no messages, no priority/assignment/site/category/level/SLA changes).
 * No role names are used anywhere.
 */

export const STATUS_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
	open: ['pending', 'resolved'],
	pending: ['open', 'resolved'],
	resolved: ['open', 'closed'],
	closed: ['open']
};

export type ActionBlock = 'requester-view' | 'missing-capability' | 'closed';

export interface ActionAvailability {
	readonly available: boolean;
	/** Why it is not offered (null when available). */
	readonly blockedBy: ActionBlock | null;
}

export interface IncidentActions {
	readonly changeStatus: ActionAvailability & { readonly targets: readonly IncidentStatus[] };
	readonly changePriority: ActionAvailability;
	readonly changeSupportLevel: ActionAvailability;
	readonly changeSite: ActionAvailability;
	readonly changeCategory: ActionAvailability;
	readonly assign: ActionAvailability;
	readonly changeSla: ActionAvailability;
	readonly readComments: ActionAvailability;
	readonly addComment: ActionAvailability;
	readonly readInternalNotes: ActionAvailability;
	readonly addInternalNote: ActionAvailability;
}

const OK: ActionAvailability = Object.freeze({ available: true, blockedBy: null });
const blocked = (blockedBy: ActionBlock): ActionAvailability =>
	Object.freeze({ available: false, blockedBy });

export function hasStaffScope(incident: IncidentDetailView): boolean {
	return incident.audience === 'staff';
}

export function incidentActions(
	incident: IncidentDetailView,
	capabilities: readonly string[]
): IncidentActions {
	const has = (id: string) => capabilities.includes(id);
	const staff = hasStaffScope(incident);
	const closed = incident.status === 'closed';

	/** Staff mutation gated by one capability; closed blocks unless `allowClosed`. */
	const staffMutation = (capability: string, allowClosed = false): ActionAvailability => {
		if (!staff) return blocked('requester-view');
		if (!has(capability)) return blocked('missing-capability');
		if (closed && !allowClosed) return blocked('closed');
		return OK;
	};

	const status = staffMutation('incidents:edit', true);
	return {
		changeStatus: {
			...status,
			targets: status.available ? STATUS_TRANSITIONS[incident.status] : []
		},
		changePriority: staffMutation('incidents:edit'),
		changeSupportLevel: staffMutation('incidents:edit'),
		changeSite: staffMutation('incidents:edit'),
		changeCategory: staffMutation('incidents:edit'),
		assign: staffMutation('incidents:assign'),
		changeSla: staffMutation('sla:assign'),
		// Reading the incident implies reading its public conversation (same server scope).
		readComments: OK,
		addComment: !has('incidents:add_comment')
			? blocked('missing-capability')
			: closed
				? blocked('closed')
				: OK,
		readInternalNotes: !staff
			? blocked('requester-view')
			: has('incidents:view_internal_notes')
				? OK
				: blocked('missing-capability'),
		addInternalNote: staffMutation('incidents:add_internal_note')
	};
}

// ------------------------------------------------------------------------------------------------
// Request builders (validated like the server; they never combine what the server forbids)
// ------------------------------------------------------------------------------------------------

function invalid(message: string): ApiError {
	return new ApiError(0, 'INVALID_INPUT', message);
}

/**
 * PATCH /api/incidents/:id status body. Only transitions of the real matrix; reopening a closed
 * incident is exactly `{ status: 'open' }` (never combined with priority).
 */
export function buildStatusPatch(
	current: IncidentStatus,
	target: IncidentStatus
): { status: IncidentStatus } {
	if (!STATUS_TRANSITIONS[current].includes(target))
		throw invalid('El cambio de estado solicitado no está permitido.');
	return { status: target };
}

/** PATCH /api/incidents/:id priority body; refused on a closed incident (reopen first). */
export function buildPriorityPatch(
	current: IncidentStatus,
	priority: IncidentPriority
): { priority: IncidentPriority } {
	if (current === 'closed') throw invalid('La incidencia está cerrada y no admite cambios.');
	if (!['low', 'medium', 'high', 'urgent'].includes(priority))
		throw invalid('La prioridad no es válida.');
	return { priority };
}

export const INCIDENT_REASON_MAX_LENGTH = 1000;

/** Optional change reason (assign, support level, site, category): <= 1000 after trim, no NUL. */
export function normalizeChangeReason(reason: string | undefined): string | undefined {
	if (reason === undefined) return undefined;
	if (typeof reason !== 'string') throw invalid('El motivo no es válido.');
	if (reason.includes('\u0000')) throw invalid('El motivo contiene caracteres no permitidos.');
	const trimmed = reason.trim();
	if (trimmed.length > INCIDENT_REASON_MAX_LENGTH)
		throw invalid(`El motivo no puede superar ${INCIDENT_REASON_MAX_LENGTH} caracteres.`);
	return trimmed.length > 0 ? trimmed : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AssignmentChange {
	/** undefined: unchanged; null: remove the team; UUID: that team. */
	teamId?: string | null;
	/** undefined: unchanged (the server may clear an incompatible one); null: unassign. */
	assignedToUserId?: string | null;
	reason?: string;
}

/**
 * PATCH /api/incidents/:id/assign body. Omitted and null are different on purpose and both are
 * preserved; unassigning is supported. At least one of teamId / assignedToUserId is required.
 * A confirmed assignment may remove the actor's own read access (view_own): the detail must be
 * re-read after it, never assumed readable.
 */
export function buildAssignmentPatch(change: AssignmentChange): Record<string, unknown> {
	const body: Record<string, unknown> = {};
	for (const key of ['teamId', 'assignedToUserId'] as const) {
		const value = change[key];
		if (value === undefined) continue;
		if (value !== null && (typeof value !== 'string' || !UUID.test(value)))
			throw invalid('La asignación seleccionada no es válida.');
		body[key] = value;
	}
	if (!('teamId' in body) && !('assignedToUserId' in body))
		throw invalid('Indica un equipo o un técnico.');
	const reason = normalizeChangeReason(change.reason);
	if (reason !== undefined) body.reason = reason;
	return body;
}
