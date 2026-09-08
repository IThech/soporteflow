import type { Incident } from '$lib/types/incident';
import { supportLevels } from '$lib/types/support';
export function isIncidentList(parsed: unknown): parsed is Incident[] {
	return !(
		!Array.isArray(parsed) ||
		!parsed.every(
			(item) =>
				item &&
				typeof item === 'object' &&
				Number.isSafeInteger(item.id) &&
				['title', 'client', 'createdAt'].every((key) => typeof item[key] === 'string') &&
				['open', 'pending', 'resolved'].includes(item.status) &&
				['low', 'medium', 'high'].includes(item.priority) &&
				(item.supportLevel === undefined || supportLevels.includes(item.supportLevel)) &&
				[
					'organizationId',
					'clientUserId',
					'createdByUserId',
					'assignedToUserId',
					'teamId',
					'description',
					'solution',
					'categoryId'
				].every((key) => item[key] === undefined || typeof item[key] === 'string')
		) ||
		new Set(parsed.map((item) => item.id)).size !== parsed.length
	);
}
