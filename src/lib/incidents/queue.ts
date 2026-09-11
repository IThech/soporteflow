import { canViewIncident } from '$lib/auth/record-access';
import type { Incident, IncidentStatus } from '$lib/types/incident';
import type { AppUser } from '$lib/types/user';

export type IncidentQueue = 'all' | 'mine' | 'unassigned';
export function validQueue(user: AppUser, queue: IncidentQueue): IncidentQueue {
	return user.role === 'technician' ? queue : 'all';
}
export function normalizeSearchText(value: string): string {
	return value
		.trim()
		.toLocaleLowerCase('es')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.normalize('NFC');
}
export type QueueStatusFilter = 'all' | 'active' | IncidentStatus;

export function queueIncidents(
	user: AppUser,
	incidents: Incident[],
	queue: IncidentQueue
): Incident[] {
	const view = validQueue(user, queue);
	const result = incidents.filter(
		(incident) =>
			canViewIncident(user, incident) &&
			(view === 'all' ||
				(view === 'mine' ? incident.assignedToUserId === user.id : !incident.assignedToUserId))
	);
	if (view !== 'mine') return result;
	const rank = { high: 0, medium: 1, low: 2 };
	const isInactive = (status: IncidentStatus) => status === 'resolved' || status === 'closed';
	const date = (value: string) =>
		Number.isFinite(Date.parse(value)) ? Date.parse(value) : Number.MAX_SAFE_INTEGER;
	return result.sort(
		(a, b) =>
			Number(isInactive(a.status)) - Number(isInactive(b.status)) ||
			rank[a.priority] - rank[b.priority] ||
			date(a.createdAt) - date(b.createdAt) ||
			a.id - b.id
	);
}
export function filterIncidentQueue(
	user: AppUser,
	incidents: Incident[],
	queue: IncidentQueue,
	status: QueueStatusFilter,
	search: string
): Incident[] {
	const query = normalizeSearchText(search);
	const idQuery = query.startsWith('#') ? query.slice(1) : query;
	return queueIncidents(user, incidents, queue).filter(
		(incident) =>
			(status === 'all'
				? true
				: status === 'active'
					? incident.status === 'open' || incident.status === 'pending'
					: incident.status === status) &&
			((/^\d+$/.test(idQuery) && incident.id === Number(idQuery)) ||
				normalizeSearchText(incident.title).includes(query) ||
				normalizeSearchText(incident.client).includes(query))
	);
}
