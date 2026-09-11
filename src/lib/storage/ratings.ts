import type { IncidentRating } from '$lib/types/incident-rating';
import { getResolutionRatingKey } from '$lib/incidents/closure';

export const RATINGS_KEY = 'soporteflow-incident-ratings';

export type RatingLoadResult =
	| { status: 'missing'; ratings: IncidentRating[] }
	| { status: 'valid'; ratings: IncidentRating[] }
	| { status: 'corrupt'; error: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && !!v.trim();

const isValidTimestamp = (v: unknown): v is string =>
	typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));

export function isIncidentRating(value: unknown): value is IncidentRating {
	if (!isObject(value)) return false;

	if (
		!isNonEmptyString(value.id) ||
		!isNonEmptyString(value.organizationId) ||
		!isNonEmptyString(value.technicianUserId) ||
		!isNonEmptyString(value.clientUserId) ||
		!isValidTimestamp(value.resolvedAt) ||
		!isValidTimestamp(value.createdAt)
	) {
		return false;
	}

	if (!Number.isSafeInteger(value.incidentId) || (value.incidentId as number) <= 0) {
		return false;
	}

	if (
		!Number.isInteger(value.rating) ||
		(value.rating as number) < 1 ||
		(value.rating as number) > 5
	) {
		return false;
	}

	if (value.comment !== undefined && typeof value.comment !== 'string') {
		return false;
	}

	return true;
}

export function isIncidentRatingList(value: unknown): value is IncidentRating[] {
	if (!Array.isArray(value)) return false;

	const ids = new Set<string>();
	const resolutionKeys = new Set<string>();

	for (const item of value) {
		if (!isIncidentRating(item)) return false;
		if (ids.has(item.id)) return false;
		ids.add(item.id);

		// Enforce cycle-level uniqueness: one rating per resolution cycle
		const key = getResolutionRatingKey(item.organizationId, item.incidentId, item.resolvedAt);
		if (resolutionKeys.has(key)) return false;
		resolutionKeys.add(key);
	}

	return true;
}

export function loadIncidentRatings(storage: Storage = localStorage): RatingLoadResult {
	try {
		const raw = storage.getItem(RATINGS_KEY);
		if (raw === null) {
			return { status: 'missing', ratings: [] };
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return {
				status: 'corrupt',
				error: 'Formato JSON no válido en el almacenamiento de valoraciones'
			};
		}

		if (!isIncidentRatingList(parsed)) {
			return {
				status: 'corrupt',
				error: 'Los datos de valoraciones almacenados no cumplen el esquema de integridad'
			};
		}

		return { status: 'valid', ratings: parsed };
	} catch (err) {
		return {
			status: 'corrupt',
			error: err instanceof Error ? err.message : 'Error al acceder al almacenamiento'
		};
	}
}

export function saveIncidentRatings(
	ratings: IncidentRating[],
	storage: Storage = localStorage
): void {
	storage.setItem(RATINGS_KEY, JSON.stringify(ratings));
}
