import type { IncidentHistoryEntry } from '$lib/types/incident-history';
import { supportLevels } from '$lib/types/support';

const object = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const optionalText = (v: unknown) => v === undefined || typeof v === 'string';
const status = (v: unknown) => v === 'open' || v === 'pending' || v === 'resolved';
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
				'resolved'
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
