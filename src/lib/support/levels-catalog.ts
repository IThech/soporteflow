import { canAccessOrganization, hasPermission } from '$lib/auth/permissions';
import { demoSupportLevels } from '$lib/data/support-levels';
import { demoOrganization } from '$lib/data/organizations';
import type { Incident } from '$lib/types/incident';
import type {
	CreateSupportLevelInput,
	SupportCatalogReferences,
	SupportLevelDefinition,
	UpdateSupportLevelInput
} from '$lib/types/support';
import type { AppUser } from '$lib/types/user';

export const SUPPORT_LEVELS_STORAGE_KEY = 'soporteflow-support-levels';

export type SupportLevelLoadResult =
	| { status: 'missing'; seededLevels: SupportLevelDefinition[] }
	| { status: 'valid'; levels: SupportLevelDefinition[] }
	| { status: 'corrupt'; error: string };

export function normalizeLevelCode(code: string): string {
	return code.trim().toUpperCase();
}

export function isValidLevelCode(code: string): boolean {
	const normalized = normalizeLevelCode(code);
	return /^[A-Z0-9_\-.]{1,15}$/.test(normalized);
}

export function isSupportLevel(item: unknown): item is SupportLevelDefinition {
	if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
	const l = item as Record<string, unknown>;

	return (
		typeof l.id === 'string' &&
		l.id.trim().length > 0 &&
		typeof l.organizationId === 'string' &&
		l.organizationId.trim().length > 0 &&
		typeof l.code === 'string' &&
		l.code.trim().length > 0 &&
		isValidLevelCode(l.code) &&
		typeof l.name === 'string' &&
		l.name.trim().length >= 2 &&
		(l.description === undefined || typeof l.description === 'string') &&
		typeof l.order === 'number' &&
		Number.isSafeInteger(l.order) &&
		l.order >= 1 &&
		typeof l.active === 'boolean' &&
		typeof l.createdAt === 'string' &&
		Number.isFinite(Date.parse(l.createdAt))
	);
}

export function isSupportLevelList(value: unknown): value is SupportLevelDefinition[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>();
	const orgCodes = new Set<string>();

	return value.every((item) => {
		if (!isSupportLevel(item)) return false;
		if (ids.has(item.id)) return false;
		ids.add(item.id);

		const orgCodeKey = `${item.organizationId}:::${normalizeLevelCode(item.code)}`;
		if (orgCodes.has(orgCodeKey)) return false;
		orgCodes.add(orgCodeKey);

		return true;
	});
}

export function loadSupportLevelsResult(raw: string | null): SupportLevelLoadResult {
	if (raw === null) {
		return {
			status: 'missing',
			seededLevels: demoSupportLevels.map((l) => ({ ...l }))
		};
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (isSupportLevelList(parsed)) {
			return {
				status: 'valid',
				levels: parsed
			};
		}
		return {
			status: 'corrupt',
			error: 'El catálogo de niveles de soporte guardado no tiene un formato válido.'
		};
	} catch (err) {
		return {
			status: 'corrupt',
			error:
				err instanceof Error
					? `No se pudo parsear el catálogo de niveles: ${err.message}`
					: 'Error al cargar niveles guardados.'
		};
	}
}

export function saveSupportLevels(storage: Storage, levels: SupportLevelDefinition[]): void {
	if (!isSupportLevelList(levels)) {
		throw new Error('La lista de niveles de soporte no tiene un formato válido.');
	}
	storage.setItem(SUPPORT_LEVELS_STORAGE_KEY, JSON.stringify(levels));
}

export function getOrganizationLevels(
	levels: SupportLevelDefinition[],
	organizationId: string
): SupportLevelDefinition[] {
	return levels
		.filter((l) => l.organizationId === organizationId)
		.sort((a, b) => a.order - b.order);
}

export function countSupportLevelReferences(
	organizationId: string,
	code: string,
	users: AppUser[],
	incidents: Incident[]
): SupportCatalogReferences {
	const normalizedCode = normalizeLevelCode(code);
	const targetOrgId = organizationId || demoOrganization.id;

	const userCount = users.filter((u) => {
		const uOrgId = u.organizationId || demoOrganization.id;
		return (
			uOrgId === targetOrgId &&
			typeof u.supportLevel === 'string' &&
			normalizeLevelCode(u.supportLevel) === normalizedCode
		);
	}).length;

	const activeIncidentCount = incidents.filter((inc) => {
		const incOrgId = inc.organizationId || demoOrganization.id;
		return (
			incOrgId === targetOrgId &&
			inc.status !== 'closed' &&
			typeof inc.supportLevel === 'string' &&
			normalizeLevelCode(inc.supportLevel) === normalizedCode
		);
	}).length;

	return { userCount, activeIncidentCount };
}

function normalizeOrders(orgLevels: SupportLevelDefinition[]): SupportLevelDefinition[] {
	return orgLevels.map((level, index) => ({
		...level,
		order: index + 1
	}));
}

export function createSupportLevel(
	actor: AppUser,
	levels: SupportLevelDefinition[],
	input: CreateSupportLevelInput
): SupportLevelDefinition[] {
	if (!hasPermission(actor, 'organization:manage')) {
		throw new Error('No tienes permisos para gestionar niveles de soporte.');
	}

	const targetOrgId = input.organizationId.trim();
	if (!targetOrgId || !canAccessOrganization(actor, targetOrgId)) {
		throw new Error('No tienes permiso para gestionar niveles de otra organización.');
	}

	const code = normalizeLevelCode(input.code);
	if (!code || !isValidLevelCode(code)) {
		throw new Error('El código del nivel debe tener entre 1 y 15 caracteres alfanuméricos.');
	}

	const orgLevels = getOrganizationLevels(levels, targetOrgId);
	if (orgLevels.some((l) => normalizeLevelCode(l.code) === code)) {
		throw new Error(`Ya existe un nivel con el código "${code}" en esta organización.`);
	}

	const name = input.name.trim();
	if (!name || name.length < 2) {
		throw new Error('Escribe un nombre de al menos 2 caracteres.');
	}

	const active = input.active ?? true;
	const createdAt = new Date().toISOString().slice(0, 10);
	const description = input.description?.trim() || undefined;

	const nextOrder = orgLevels.length + 1;
	const newLevel: SupportLevelDefinition = {
		id: crypto.randomUUID(),
		organizationId: targetOrgId,
		code,
		name,
		...(description ? { description } : {}),
		order: nextOrder,
		active,
		createdAt
	};

	return [...levels, newLevel];
}

export function updateSupportLevel(
	actor: AppUser,
	levels: SupportLevelDefinition[],
	input: UpdateSupportLevelInput
): SupportLevelDefinition[] {
	if (!hasPermission(actor, 'organization:manage')) {
		throw new Error('No tienes permisos para gestionar niveles de soporte.');
	}

	const target = levels.find((l) => l.id === input.id);
	if (!target) {
		throw new Error('El nivel de soporte no existe.');
	}

	if (!canAccessOrganization(actor, target.organizationId)) {
		throw new Error('No tienes permiso para gestionar niveles de otra organización.');
	}

	const name = input.name.trim();
	if (!name || name.length < 2) {
		throw new Error('Escribe un nombre de al menos 2 caracteres.');
	}

	const description =
		input.description !== undefined ? input.description.trim() || undefined : target.description;
	const active = input.active !== undefined ? input.active : target.active;

	const updated: SupportLevelDefinition = {
		...target,
		name,
		...(description ? { description } : {}),
		active
	};
	if (!description) delete updated.description;

	return levels.map((l) => (l.id === target.id ? updated : l));
}

export function toggleSupportLevelActive(
	actor: AppUser,
	levels: SupportLevelDefinition[],
	levelId: string
): SupportLevelDefinition[] {
	if (!hasPermission(actor, 'organization:manage')) {
		throw new Error('No tienes permisos para gestionar niveles de soporte.');
	}

	const target = levels.find((l) => l.id === levelId);
	if (!target) {
		throw new Error('El nivel de soporte no existe.');
	}

	if (!canAccessOrganization(actor, target.organizationId)) {
		throw new Error('No tienes permiso para gestionar niveles de otra organización.');
	}

	return levels.map((l) => (l.id === levelId ? { ...l, active: !l.active } : l));
}

export function reorderSupportLevel(
	actor: AppUser,
	levels: SupportLevelDefinition[],
	levelId: string,
	direction: 'up' | 'down'
): SupportLevelDefinition[] {
	if (!hasPermission(actor, 'organization:manage')) {
		throw new Error('No tienes permisos para gestionar niveles de soporte.');
	}

	const target = levels.find((l) => l.id === levelId);
	if (!target) {
		throw new Error('El nivel de soporte no existe.');
	}

	if (!canAccessOrganization(actor, target.organizationId)) {
		throw new Error('No tienes permiso para gestionar niveles de otra organización.');
	}

	const orgLevels = getOrganizationLevels(levels, target.organizationId);
	const currentIndex = orgLevels.findIndex((l) => l.id === levelId);
	if (currentIndex === -1) return levels;

	const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
	if (targetIndex < 0 || targetIndex >= orgLevels.length) {
		return levels; // Already at edge
	}

	// Swap in copy of orgLevels
	const reordered = [...orgLevels];
	const [moved] = reordered.splice(currentIndex, 1);
	reordered.splice(targetIndex, 0, moved);

	const normalized = normalizeOrders(reordered);
	const normalizedMap = new Map(normalized.map((l) => [l.id, l]));

	return levels.map((l) => normalizedMap.get(l.id) ?? l);
}
