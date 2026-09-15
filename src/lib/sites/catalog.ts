import { canAccessOrganization, hasPermission } from '$lib/auth/permissions';
import { demoSites } from '$lib/data/sites';
import { demoOrganization } from '$lib/data/organizations';
import type { Incident } from '$lib/types/incident';
import type { CreateSiteInput, Site, SiteReferences, UpdateSiteInput } from '$lib/types/site';
import type { AppUser } from '$lib/types/user';

export const SITES_STORAGE_KEY = 'soporteflow-sites';

export type SiteLoadResult =
	| { status: 'missing'; seededSites: Site[] }
	| { status: 'valid'; sites: Site[] }
	| { status: 'corrupt'; error: string };

export function normalizeSiteName(name: string): string {
	return name.trim().toLowerCase();
}

export function isSite(item: unknown): item is Site {
	if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
	const s = item as Record<string, unknown>;

	return (
		typeof s.id === 'string' &&
		s.id.trim().length > 0 &&
		typeof s.organizationId === 'string' &&
		s.organizationId.trim().length > 0 &&
		typeof s.name === 'string' &&
		s.name.trim().length >= 2 &&
		(s.description === undefined || typeof s.description === 'string') &&
		typeof s.active === 'boolean' &&
		(s.createdAt === undefined ||
			(typeof s.createdAt === 'string' && Number.isFinite(Date.parse(s.createdAt))))
	);
}

export function isSiteList(value: unknown): value is Site[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>();
	const orgNames = new Set<string>();

	return value.every((item) => {
		if (!isSite(item)) return false;
		if (ids.has(item.id)) return false;
		ids.add(item.id);

		const orgNameKey = `${item.organizationId}:::${normalizeSiteName(item.name)}`;
		if (orgNames.has(orgNameKey)) return false;
		orgNames.add(orgNameKey);

		return true;
	});
}

export function loadSitesResult(raw: string | null): SiteLoadResult {
	if (raw === null) {
		return {
			status: 'missing',
			seededSites: demoSites.map((s) => ({ ...s }))
		};
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (isSiteList(parsed)) {
			return {
				status: 'valid',
				sites: parsed
			};
		}
		return {
			status: 'corrupt',
			error: 'El catálogo de sedes guardado no tiene un formato válido.'
		};
	} catch (err) {
		return {
			status: 'corrupt',
			error:
				err instanceof Error
					? `No se pudo parsear el catálogo de sedes: ${err.message}`
					: 'Error al cargar sedes guardadas.'
		};
	}
}

export function saveSites(storage: Storage, sites: Site[]): void {
	if (!isSiteList(sites)) {
		throw new Error('La lista de sedes no tiene un formato válido.');
	}
	storage.setItem(SITES_STORAGE_KEY, JSON.stringify(sites));
}

export function getOrganizationSites(sites: Site[], organizationId: string): Site[] {
	return sites.filter((s) => s.organizationId === organizationId);
}

export function countSiteReferences(
	organizationId: string,
	siteId: string,
	users: AppUser[],
	incidents: Incident[]
): SiteReferences {
	const targetOrgId = organizationId || demoOrganization.id;

	const userCount = users.filter((u) => {
		const uOrgId = u.organizationId || demoOrganization.id;
		return uOrgId === targetOrgId && Array.isArray(u.siteIds) && u.siteIds.includes(siteId);
	}).length;

	const activeIncidentCount = incidents.filter((inc) => {
		const incOrgId = inc.organizationId || demoOrganization.id;
		return incOrgId === targetOrgId && inc.status !== 'closed' && inc.siteId === siteId;
	}).length;

	return { userCount, activeIncidentCount };
}

export function createSite(actor: AppUser, sites: Site[], input: CreateSiteInput): Site[] {
	if (!hasPermission(actor, 'organization:manage')) {
		throw new Error('No tienes permisos para gestionar sedes.');
	}

	const targetOrgId = input.organizationId.trim();
	if (!targetOrgId || !canAccessOrganization(actor, targetOrgId)) {
		throw new Error('No tienes permiso para gestionar sedes de otra organización.');
	}

	const name = input.name.trim();
	if (!name || name.length < 2) {
		throw new Error('Escribe un nombre de al menos 2 caracteres.');
	}

	const orgSites = getOrganizationSites(sites, targetOrgId);
	const normalizedName = normalizeSiteName(name);
	if (orgSites.some((s) => normalizeSiteName(s.name) === normalizedName)) {
		throw new Error(`Ya existe una sede con el nombre "${name}" en esta organización.`);
	}

	const active = input.active ?? true;
	const createdAt = new Date().toISOString().slice(0, 10);
	const description = input.description?.trim() || undefined;

	const newSite: Site = {
		id: crypto.randomUUID(),
		organizationId: targetOrgId,
		name,
		...(description ? { description } : {}),
		active,
		createdAt
	};

	return [...sites, newSite];
}

export function updateSite(actor: AppUser, sites: Site[], input: UpdateSiteInput): Site[] {
	if (!hasPermission(actor, 'organization:manage')) {
		throw new Error('No tienes permisos para gestionar sedes.');
	}

	const target = sites.find((s) => s.id === input.id);
	if (!target) {
		throw new Error('La sede no existe.');
	}

	if (!canAccessOrganization(actor, target.organizationId)) {
		throw new Error('No tienes permiso para gestionar sedes de otra organización.');
	}

	const name = input.name.trim();
	if (!name || name.length < 2) {
		throw new Error('Escribe un nombre de al menos 2 caracteres.');
	}

	const orgSites = getOrganizationSites(sites, target.organizationId);
	const normalizedName = normalizeSiteName(name);
	if (orgSites.some((s) => s.id !== target.id && normalizeSiteName(s.name) === normalizedName)) {
		throw new Error(`Ya existe otra sede con el nombre "${name}" en esta organización.`);
	}

	const description =
		input.description !== undefined ? input.description.trim() || undefined : target.description;
	const active = input.active !== undefined ? input.active : target.active;

	const updated: Site = {
		...target,
		name,
		...(description ? { description } : {}),
		active
	};
	if (!description) delete updated.description;

	return sites.map((s) => (s.id === target.id ? updated : s));
}

export function toggleSiteActive(actor: AppUser, sites: Site[], siteId: string): Site[] {
	if (!hasPermission(actor, 'organization:manage')) {
		throw new Error('No tienes permisos para gestionar sedes.');
	}

	const target = sites.find((s) => s.id === siteId);
	if (!target) {
		throw new Error('La sede no existe.');
	}

	if (!canAccessOrganization(actor, target.organizationId)) {
		throw new Error('No tienes permiso para gestionar sedes de otra organización.');
	}

	return sites.map((s) => (s.id === siteId ? { ...s, active: !s.active } : s));
}
