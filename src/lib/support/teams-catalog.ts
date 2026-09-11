import { canAccessOrganization, hasPermission } from '$lib/auth/permissions';
import { demoSupportTeams } from '$lib/data/teams';
import { demoOrganization } from '$lib/data/organizations';
import type { Incident } from '$lib/types/incident';
import type {
	CreateSupportTeamInput,
	SupportCatalogReferences,
	SupportTeam,
	UpdateSupportTeamInput
} from '$lib/types/support';
import type { AppUser } from '$lib/types/user';

export const SUPPORT_TEAMS_STORAGE_KEY = 'soporteflow-teams';

export type SupportTeamLoadResult =
	| { status: 'missing'; seededTeams: SupportTeam[] }
	| { status: 'valid'; teams: SupportTeam[] }
	| { status: 'corrupt'; error: string };

export function normalizeTeamName(name: string): string {
	return name.trim().toLowerCase();
}

export function isSupportTeam(item: unknown): item is SupportTeam {
	if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
	const t = item as Record<string, unknown>;

	return (
		typeof t.id === 'string' &&
		t.id.trim().length > 0 &&
		typeof t.organizationId === 'string' &&
		t.organizationId.trim().length > 0 &&
		typeof t.name === 'string' &&
		t.name.trim().length >= 2 &&
		(t.description === undefined || typeof t.description === 'string') &&
		typeof t.active === 'boolean' &&
		(t.createdAt === undefined ||
			(typeof t.createdAt === 'string' && Number.isFinite(Date.parse(t.createdAt))))
	);
}

export function isSupportTeamList(value: unknown): value is SupportTeam[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>();
	const orgNames = new Set<string>();

	return value.every((item) => {
		if (!isSupportTeam(item)) return false;
		if (ids.has(item.id)) return false;
		ids.add(item.id);

		const orgNameKey = `${item.organizationId}:::${normalizeTeamName(item.name)}`;
		if (orgNames.has(orgNameKey)) return false;
		orgNames.add(orgNameKey);

		return true;
	});
}

export function loadSupportTeamsResult(raw: string | null): SupportTeamLoadResult {
	if (raw === null) {
		return {
			status: 'missing',
			seededTeams: demoSupportTeams.map((t) => ({ ...t }))
		};
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (isSupportTeamList(parsed)) {
			return {
				status: 'valid',
				teams: parsed
			};
		}
		return {
			status: 'corrupt',
			error: 'El catálogo de equipos guardado no tiene un formato válido.'
		};
	} catch (err) {
		return {
			status: 'corrupt',
			error:
				err instanceof Error
					? `No se pudo parsear el catálogo de equipos: ${err.message}`
					: 'Error al cargar equipos guardados.'
		};
	}
}

export function saveSupportTeams(storage: Storage, teams: SupportTeam[]): void {
	if (!isSupportTeamList(teams)) {
		throw new Error('La lista de equipos no tiene un formato válido.');
	}
	storage.setItem(SUPPORT_TEAMS_STORAGE_KEY, JSON.stringify(teams));
}

export function getOrganizationTeams(teams: SupportTeam[], organizationId: string): SupportTeam[] {
	return teams.filter((t) => t.organizationId === organizationId);
}

export function countSupportTeamReferences(
	organizationId: string,
	teamId: string,
	users: AppUser[],
	incidents: Incident[]
): SupportCatalogReferences {
	const targetOrgId = organizationId || demoOrganization.id;

	const userCount = users.filter((u) => {
		const uOrgId = u.organizationId || demoOrganization.id;
		return uOrgId === targetOrgId && u.teamId === teamId;
	}).length;

	const activeIncidentCount = incidents.filter((inc) => {
		const incOrgId = inc.organizationId || demoOrganization.id;
		return incOrgId === targetOrgId && inc.status !== 'closed' && inc.teamId === teamId;
	}).length;

	return { userCount, activeIncidentCount };
}

export function createSupportTeam(
	actor: AppUser,
	teams: SupportTeam[],
	input: CreateSupportTeamInput
): SupportTeam[] {
	if (!hasPermission(actor, 'organization:manage')) {
		throw new Error('No tienes permisos para gestionar equipos.');
	}

	const targetOrgId = input.organizationId.trim();
	if (!targetOrgId || !canAccessOrganization(actor, targetOrgId)) {
		throw new Error('No tienes permiso para gestionar equipos de otra organización.');
	}

	const name = input.name.trim();
	if (!name || name.length < 2) {
		throw new Error('Escribe un nombre de al menos 2 caracteres.');
	}

	const orgTeams = getOrganizationTeams(teams, targetOrgId);
	const normalizedName = normalizeTeamName(name);
	if (orgTeams.some((t) => normalizeTeamName(t.name) === normalizedName)) {
		throw new Error(`Ya existe un equipo con el nombre "${name}" en esta organización.`);
	}

	const active = input.active ?? true;
	const createdAt = new Date().toISOString().slice(0, 10);
	const description = input.description?.trim() || undefined;

	const newTeam: SupportTeam = {
		id: crypto.randomUUID(),
		organizationId: targetOrgId,
		name,
		...(description ? { description } : {}),
		active,
		createdAt
	};

	return [...teams, newTeam];
}

export function updateSupportTeam(
	actor: AppUser,
	teams: SupportTeam[],
	input: UpdateSupportTeamInput
): SupportTeam[] {
	if (!hasPermission(actor, 'organization:manage')) {
		throw new Error('No tienes permisos para gestionar equipos.');
	}

	const target = teams.find((t) => t.id === input.id);
	if (!target) {
		throw new Error('El equipo no existe.');
	}

	if (!canAccessOrganization(actor, target.organizationId)) {
		throw new Error('No tienes permiso para gestionar equipos de otra organización.');
	}

	const name = input.name.trim();
	if (!name || name.length < 2) {
		throw new Error('Escribe un nombre de al menos 2 caracteres.');
	}

	const orgTeams = getOrganizationTeams(teams, target.organizationId);
	const normalizedName = normalizeTeamName(name);
	if (orgTeams.some((t) => t.id !== target.id && normalizeTeamName(t.name) === normalizedName)) {
		throw new Error(`Ya existe otro equipo con el nombre "${name}" en esta organización.`);
	}

	const description =
		input.description !== undefined ? input.description.trim() || undefined : target.description;
	const active = input.active !== undefined ? input.active : target.active;

	const updated: SupportTeam = {
		...target,
		name,
		...(description ? { description } : {}),
		active
	};
	if (!description) delete updated.description;

	return teams.map((t) => (t.id === target.id ? updated : t));
}

export function toggleSupportTeamActive(
	actor: AppUser,
	teams: SupportTeam[],
	teamId: string
): SupportTeam[] {
	if (!hasPermission(actor, 'organization:manage')) {
		throw new Error('No tienes permisos para gestionar equipos.');
	}

	const target = teams.find((t) => t.id === teamId);
	if (!target) {
		throw new Error('El equipo no existe.');
	}

	if (!canAccessOrganization(actor, target.organizationId)) {
		throw new Error('No tienes permiso para gestionar equipos de otra organización.');
	}

	return teams.map((t) => (t.id === teamId ? { ...t, active: !t.active } : t));
}
