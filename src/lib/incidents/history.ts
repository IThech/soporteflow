import type { IncidentHistoryEntry } from '$lib/types/incident-history';
import { supportLevels } from '$lib/types/support';

/**
 * Transitional system actor identifier for client-side v1 automatic actions (e.g. auto-close).
 * In future backend iterations with audit logs, this will transition to a dedicated actorType ('user' | 'system').
 */
export const SYSTEM_ACTOR_ID = 'system';

const object = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const optionalText = (v: unknown) => v === undefined || typeof v === 'string';
const status = (v: unknown) =>
	v === 'open' || v === 'pending' || v === 'resolved' || v === 'closed';
const closureType = (v: unknown) => v === 'client_confirmed' || v === 'auto_closed';
const priority = (v: unknown) => v === 'low' || v === 'medium' || v === 'high';
const nullableId = (v: unknown) => v === null || text(v);
const routing = (v: unknown) =>
	object(v) &&
	(v.supportLevel === undefined ||
		v.supportLevel === null ||
		supportLevels.some((level) => level === v.supportLevel)) &&
	['teamId', 'assignedToUserId'].every((key) => v[key] === undefined || nullableId(v[key]));

function validValue(event: string, value: unknown): boolean {
	if (value === undefined) return true;
	switch (event) {
		case 'assigned':
		case 'reassigned':
		case 'category_changed':
			return nullableId(value);
		case 'status_changed':
			return status(value);
		case 'priority_changed':
			return priority(value);
		case 'escalated':
			return routing(value);
		case 'created':
			return (
				object(value) &&
				text(value.title) &&
				status(value.status) &&
				priority(value.priority) &&
				routing(value)
			);
		case 'resolved':
			return object(value) && status(value.status) && optionalText(value.solution);
		case 'resolution_accepted':
			return (
				object(value) &&
				value.status === 'closed' &&
				text(value.closedAt) &&
				value.closureType === 'client_confirmed'
			);
		case 'resolution_rejected':
			return object(value) && value.status === 'open' && text(value.comment);
		case 'closed':
			return (
				object(value) &&
				value.status === 'closed' &&
				text(value.closedAt) &&
				closureType(value.closureType)
			);
		case 'reopened':
			return object(value) && value.status === 'open' && optionalText(value.reason);
		default:
			return false;
	}
}

export function isIncidentHistory(value: unknown): value is IncidentHistoryEntry[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>();
	return value.every((entry: unknown) => {
		if (
			!object(entry) ||
			!text(entry.id) ||
			ids.has(entry.id) ||
			!Number.isSafeInteger(entry.incidentId) ||
			!text(entry.organizationId) ||
			!text(entry.actorUserId) ||
			!text(entry.timestamp) ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.timestamp) ||
			!Number.isFinite(Date.parse(entry.timestamp)) ||
			!text(entry.eventType) ||
			![
				'created',
				'assigned',
				'reassigned',
				'escalated',
				'status_changed',
				'priority_changed',
				'category_changed',
				'resolved',
				'resolution_accepted',
				'resolution_rejected',
				'closed',
				'reopened'
			].includes(entry.eventType) ||
			!optionalText(entry.reason) ||
			!optionalText(entry.comment) ||
			!validValue(entry.eventType, entry.previousValue) ||
			!validValue(entry.eventType, entry.newValue)
		)
			return false;
		ids.add(entry.id);
		return true;
	});
}
