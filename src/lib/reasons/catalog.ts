import { canAccessOrganization, hasPermission } from '$lib/auth/permissions';
import { normalizeSearchText } from '$lib/incidents/queue';
import { initialReassignmentReasons } from '$lib/data/reassignment-reasons';
import type { ReassignmentReason } from '$lib/types/reassignment-reason';
import type { AppUser } from '$lib/types/user';

export const REASONS_KEY = 'soporteflow-reassignment-reasons';
export const OTHER_REASON = '__other__';
export type ReasonChange =
	{ type: 'save'; id?: string; name: string; description: string } | { type: 'toggle'; id: string };
const normalizedName = (name: string) => normalizeSearchText(name).replace(/\s+/g, '');
export function isReasonList(value: unknown): value is ReassignmentReason[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>();
	return value.every((item) => {
		if (
			!item ||
			typeof item !== 'object' ||
			Array.isArray(item) ||
			!['id', 'organizationId', 'name', 'createdAt'].every(
				(key) => typeof item[key] === 'string' && !!item[key].trim()
			) ||
			item.id === OTHER_REASON ||
			ids.has(item.id) ||
			typeof item.active !== 'boolean' ||
			!['description', 'updatedAt'].every(
				(key) => item[key] === undefined || typeof item[key] === 'string'
			) ||
			!Number.isFinite(Date.parse(item.createdAt)) ||
			(item.updatedAt !== undefined && !Number.isFinite(Date.parse(item.updatedAt)))
		)
			return false;
		ids.add(item.id);
		return true;
	});
}
export function loadReasons(raw: string | null): ReassignmentReason[] {
	const parsed: unknown =
		raw === null ? initialReassignmentReasons.map((item) => ({ ...item })) : JSON.parse(raw);
	if (!isReasonList(parsed))
		throw new Error(
			'No se pudo cargar el catálogo de motivos. Los datos guardados se han conservado.'
		);
	return parsed;
}
export function activeReasons(
	reasons: ReassignmentReason[],
	organizationId: string
): ReassignmentReason[] {
	return reasons.filter((reason) => reason.active && reason.organizationId === organizationId);
}
export function resolveReason(
	reasons: ReassignmentReason[],
	organizationId: string,
	selection: string,
	manual: string
): string {
	if (selection === OTHER_REASON) {
		if (!manual.trim()) throw new Error('Describe el motivo; no puede estar vacío.');
		return manual.trim();
	}
	const reason = activeReasons(reasons, organizationId).find((item) => item.id === selection);
	if (!reason) throw new Error('Selecciona un motivo activo de la organización o utiliza Otro.');
	return reason.name.trim();
}
export function changeReason(
	user: AppUser,
	list: ReassignmentReason[],
	change: ReasonChange
): ReassignmentReason[] {
	if (!hasPermission(user, 'organization:manage'))
		throw new Error('No tienes permiso para gestionar motivos.');
	const original = change.id === undefined ? undefined : list.find((item) => item.id === change.id);
	if (change.id !== undefined && !original) throw new Error('El motivo ya no está disponible.');
	const organizationId = original?.organizationId ?? user.organizationId;
	if (!organizationId || !canAccessOrganization(user, organizationId))
		throw new Error('No puedes gestionar motivos de esta organización.');
	const timestamp = new Date().toISOString();
	if (change.type === 'toggle')
		return list.map((item) =>
			item.id === original!.id ? { ...item, active: !item.active, updatedAt: timestamp } : item
		);
	const name = change.name.trim();
	if (!name) throw new Error('Escribe un nombre para el motivo.');
	if (normalizedName(name) === 'otro')
		throw new Error('Otro es la opción de texto libre; utiliza un nombre distinto.');
	if (
		list.some(
			(item) =>
				item.id !== original?.id &&
				item.organizationId === organizationId &&
				normalizedName(item.name) === normalizedName(name)
		)
	)
		throw new Error('Ya existe un motivo con ese nombre en la organización, activo o inactivo.');
	const reason: ReassignmentReason = original
		? { ...original, name, description: change.description.trim(), updatedAt: timestamp }
		: {
				id: crypto.randomUUID(),
				organizationId,
				name,
				description: change.description.trim(),
				active: true,
				createdAt: timestamp
			};
	return original
		? list.map((item) => (item.id === original.id ? reason : item))
		: [...list, reason];
}
export function saveReasons(
	storage: Pick<Storage, 'getItem' | 'setItem'>,
	list: ReassignmentReason[],
	expected: string | null
): string {
	if (storage.getItem(REASONS_KEY) !== expected)
		throw new Error('El catálogo ha cambiado en otra pestaña. Recarga antes de continuar.');
	if (!isReasonList(list)) throw new Error('El catálogo no tiene un formato válido.');
	const raw = JSON.stringify(list);
	storage.setItem(REASONS_KEY, raw);
	return raw;
}
