import { ApiError, isApiError, networkApiError } from '../api/errors.ts';
import type { IncidentDetailView } from '../api/incident-detail.ts';
import { isStaleRequest } from './request-scope.ts';
import {
	createTenantCatalogCache,
	type CatalogName,
	type TenantCatalogCache
} from './tenant-catalog.ts';
import { tenantKey, type TenantIdentity } from './tenant-identity.ts';

/**
 * UI-2C — catalogs of the incident detail, on top of the UI-2A tenant-bound cache (user +
 * organization + generation; deduplicated; never persisted; dropped on any identity change):
 * - names for the STAFF view only (site, category, requester member), each loaded only when the
 *   capability exists and the incident actually references one. A requester view loads nothing;
 * - teams / assignees for the (temporary, legacy) assignment form, loaded on demand.
 * Team and assignee names of the incident itself come from the detail DTO, never from here.
 * A failed catalog is an error state (names fall back to "No disponible"), never an empty list.
 */

export interface NamedItem {
	id: string;
	name: string;
}

export interface DetailCatalogView {
	readonly status: 'idle' | 'loading' | 'ready' | 'error';
	readonly items: readonly NamedItem[];
	readonly error: ApiError | null;
}

export type DetailCatalogName = 'sites' | 'categories' | 'memberships' | 'teams' | 'assignees';

export interface DetailCatalogsState {
	readonly sites: DetailCatalogView;
	readonly categories: DetailCatalogView;
	readonly memberships: DetailCatalogView;
	readonly teams: DetailCatalogView;
	/** Assignees of `assigneesTeamId` (null: every assignable technician). */
	readonly assignees: DetailCatalogView;
	readonly assigneesTeamId: string | null;
}

export interface DetailCatalogLoaders {
	sites: (organizationId: string, signal: AbortSignal) => Promise<NamedItem[]>;
	categories: (organizationId: string, signal: AbortSignal) => Promise<NamedItem[]>;
	/** Members as (userId, name) of ACTIVE users. */
	memberships: (organizationId: string, signal: AbortSignal) => Promise<NamedItem[]>;
	teams: (organizationId: string, signal: AbortSignal) => Promise<NamedItem[]>;
	assignees: (
		organizationId: string,
		teamId: string | null,
		signal: AbortSignal
	) => Promise<NamedItem[]>;
}

const IDLE: DetailCatalogView = Object.freeze({ status: 'idle', items: [], error: null });
const EMPTY: DetailCatalogsState = Object.freeze({
	sites: IDLE,
	categories: IDLE,
	memberships: IDLE,
	teams: IDLE,
	assignees: IDLE,
	assigneesTeamId: null
});

/** Which name catalogs a detail needs: staff view + capability + a referenced id. */
export function nameCatalogsFor(
	detail: IncidentDetailView | null,
	capabilities: readonly string[],
	selfUserId: string | null
): Array<'sites' | 'categories' | 'memberships'> {
	if (!detail || detail.audience !== 'staff') return [];
	const names: Array<'sites' | 'categories' | 'memberships'> = [];
	if (detail.siteId && capabilities.includes('sites:view')) names.push('sites');
	if (detail.categoryId && capabilities.includes('categories:view')) names.push('categories');
	if (
		detail.clientUserId &&
		detail.clientUserId !== selfUserId &&
		capabilities.includes('memberships:view')
	)
		names.push('memberships');
	return names;
}

/** id -> name map of a ready catalog (null while loading or failed: callers show "No disponible"). */
export function namesOf(view: DetailCatalogView): ReadonlyMap<string, string> | null {
	return view.status === 'ready' ? new Map(view.items.map((item) => [item.id, item.name])) : null;
}

/** A 401 of the CURRENT identity in any detail catalog (stale answers never reach the state). */
export function catalogSessionExpiry(state: DetailCatalogsState): ApiError | null {
	for (const name of ['sites', 'categories', 'memberships', 'teams', 'assignees'] as const)
		if (state[name].error?.status === 401) return state[name].error;
	return null;
}

export interface DetailCatalogsController {
	subscribe(run: (state: DetailCatalogsState) => void): () => void;
	get(): DetailCatalogsState;
	setIdentity(identity: TenantIdentity | null): void;
	/** Loads the given name catalogs (already loaded/loading ones are left as they are). */
	loadNames(names: readonly ('sites' | 'categories' | 'memberships')[]): void;
	loadTeams(): Promise<void>;
	/** Assignees of a team (null = all); a newer request for another team wins. */
	loadAssignees(teamId: string | null): Promise<void>;
	dispose(): void;
}

export function createIncidentDetailCatalogs(
	loaders: DetailCatalogLoaders,
	cache: TenantCatalogCache = createTenantCatalogCache()
): DetailCatalogsController {
	const listeners = new Set<(state: DetailCatalogsState) => void>();
	let state: DetailCatalogsState = EMPTY;
	let identity: TenantIdentity | null = null;

	function patch(next: Partial<DetailCatalogsState>) {
		state = { ...state, ...next };
		for (const listener of listeners) listener(state);
	}

	async function load(
		name: Exclude<DetailCatalogName, 'assignees'>,
		cacheName: CatalogName,
		run: (organizationId: string, signal: AbortSignal) => Promise<NamedItem[]>
	) {
		const owner = identity;
		if (!owner) return;
		patch({ [name]: { status: 'loading', items: [], error: null } });
		try {
			const items = await cache.load(cacheName, {}, run);
			if (tenantKey(identity) !== tenantKey(owner)) return;
			patch({ [name]: { status: 'ready', items, error: null } });
		} catch (error) {
			if (isStaleRequest(error) || tenantKey(identity) !== tenantKey(owner)) return;
			patch({
				[name]: {
					status: 'error',
					items: [],
					error: isApiError(error) ? error : networkApiError()
				}
			});
		}
	}

	return {
		subscribe(run) {
			listeners.add(run);
			run(state);
			return () => listeners.delete(run);
		},
		get: () => state,
		setIdentity(next) {
			if (tenantKey(next) === tenantKey(identity)) return;
			identity = next;
			cache.setIdentity(next);
			state = EMPTY;
			for (const listener of listeners) listener(state);
		},
		loadNames(names) {
			for (const name of names)
				if (state[name].status === 'idle') void load(name, name, loaders[name]);
		},
		async loadTeams() {
			if (state.teams.status === 'ready' || state.teams.status === 'loading') return;
			await load('teams', 'teams', loaders.teams);
		},
		async loadAssignees(teamId) {
			const owner = identity;
			if (!owner) return;
			patch({ assignees: { status: 'loading', items: [], error: null }, assigneesTeamId: teamId });
			const current = () =>
				tenantKey(identity) === tenantKey(owner) && state.assigneesTeamId === teamId;
			try {
				const items = await cache.load('assignees', { teamId: teamId ?? 'all' }, (org, signal) =>
					loaders.assignees(org, teamId, signal)
				);
				if (current()) patch({ assignees: { status: 'ready', items, error: null } });
			} catch (error) {
				if (isStaleRequest(error) || !current()) return;
				patch({
					assignees: {
						status: 'error',
						items: [],
						error: isApiError(error) ? error : networkApiError()
					}
				});
			}
		},
		dispose() {
			cache.dispose();
			listeners.clear();
			identity = null;
			state = EMPTY;
		}
	};
}
