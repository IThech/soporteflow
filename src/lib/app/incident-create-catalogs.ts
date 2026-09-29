import { ApiError, isApiError, networkApiError } from '../api/errors.ts';
import type { Category } from '../api/categories.ts';
import type { Site } from '../api/sites.ts';
import type { SlaPolicy } from '../api/sla-policies.ts';
import { presentApiError } from './error-presentation.ts';
import type { CreateFormSections } from './incident-create-form.ts';
import { isStaleRequest } from './request-scope.ts';
import {
	createTenantCatalogCache,
	type CatalogLoader,
	type CatalogName,
	type TenantCatalogCache
} from './tenant-catalog.ts';
import { tenantKey, type TenantIdentity } from './tenant-identity.ts';

/**
 * UI-2B — the optional catalogs of the creation form (sites, categories,
 * SLA policies), on top of the UI-2A tenant-bound cache: keyed by user + organization +
 * generation, deduplicated, never persisted, dropped on any identity change.
 *
 * Each catalog has its own state: a failing (or 422 oversized) catalog shows ITS error with a
 * manual retry, never "no options", and never blocks the main fields. Only active entries are
 * offered (the server refuses inactive ones); labels are real names, never UUIDs.
 */

export interface CatalogOption {
	readonly value: string;
	readonly label: string;
	/** Secondary text (e.g. the member's email, "predeterminada"). */
	readonly hint?: string;
}

export type CreateCatalogName = 'sites' | 'categories' | 'slaPolicies';

export interface CatalogView {
	readonly status: 'idle' | 'loading' | 'ready' | 'error';
	readonly options: readonly CatalogOption[];
	readonly error: ApiError | null;
	/** Safe message for the error state. */
	readonly errorMessage: string | null;
}

export type CreateCatalogsState = Readonly<Record<CreateCatalogName, CatalogView>>;

export interface CreateCatalogLoaders {
	sites: (organizationId: string, signal: AbortSignal) => Promise<Site[]>;
	categories: (organizationId: string, signal: AbortSignal) => Promise<Category[]>;
	slaPolicies: (organizationId: string, signal: AbortSignal) => Promise<SlaPolicy[]>;
}

const byLabel = (a: CatalogOption, b: CatalogOption) => a.label.localeCompare(b.label, 'es');

export function siteOptions(sites: readonly Site[]): CatalogOption[] {
	return sites
		.filter((site) => site.active)
		.map((site) => ({ value: site.id, label: site.name }))
		.sort(byLabel);
}

export function categoryOptions(categories: readonly Category[]): CatalogOption[] {
	return categories
		.filter((category) => category.active)
		.map((category) => ({ value: category.id, label: category.name }))
		.sort(byLabel);
}

export function slaPolicyOptions(policies: readonly SlaPolicy[]): CatalogOption[] {
	return policies
		.filter((policy) => policy.active)
		.map((policy) => ({
			value: policy.id,
			label: policy.name,
			...(policy.isDefault ? { hint: 'predeterminada' } : {})
		}))
		.sort(byLabel);
}

/** Honest catalog error text (a 422 means the catalog exceeds what can be listed). */
export function catalogErrorMessage(error: ApiError): string {
	if (error.kind === 'unprocessable')
		return 'Hay demasiadas opciones para mostrarlas aquí. Contacta con un administrador.';
	if (error.kind === 'forbidden') return 'No tienes acceso a estas opciones.';
	return presentApiError(error).message;
}

const IDLE: CatalogView = Object.freeze({
	status: 'idle',
	options: [],
	error: null,
	errorMessage: null
});
const EMPTY_STATE: CreateCatalogsState = Object.freeze({
	sites: IDLE,
	categories: IDLE,
	slaPolicies: IDLE
});

const CACHE_NAME: Record<CreateCatalogName, CatalogName> = {
	sites: 'sites',
	categories: 'categories',
	slaPolicies: 'slaPolicies'
};

/** Server-side filters each loader applies (part of the cache key, so variants never mix). */
const CACHE_FILTERS: Record<CreateCatalogName, Readonly<Record<string, boolean>>> = {
	sites: { activeOnly: true },
	categories: { activeOnly: true },
	slaPolicies: { active: true }
};

export function catalogsFor(sections: CreateFormSections): CreateCatalogName[] {
	const names: CreateCatalogName[] = [];
	if (sections.site) names.push('sites');
	if (sections.category) names.push('categories');
	if (sections.slaPolicies) names.push('slaPolicies');
	return names;
}

export interface CreateCatalogsController {
	subscribe(run: (state: CreateCatalogsState) => void): () => void;
	get(): CreateCatalogsState;
	/** Binds to an identity (another one drops every option at once) and loads `names`. */
	setIdentity(identity: TenantIdentity | null, names: readonly CreateCatalogName[]): void;
	/** Manual retry of one catalog (a safe GET). */
	retry(name: CreateCatalogName): Promise<void>;
	dispose(): void;
}

export function createIncidentCreateCatalogs(
	loaders: CreateCatalogLoaders,
	cache: TenantCatalogCache = createTenantCatalogCache()
): CreateCatalogsController {
	const listeners = new Set<(state: CreateCatalogsState) => void>();
	let state: CreateCatalogsState = EMPTY_STATE;
	let identity: TenantIdentity | null = null;

	function set(name: CreateCatalogName, view: CatalogView) {
		state = { ...state, [name]: view };
		for (const listener of listeners) listener(state);
	}

	function options(name: CreateCatalogName, raw: unknown) {
		switch (name) {
			case 'sites':
				return siteOptions(raw as Site[]);
			case 'categories':
				return categoryOptions(raw as Category[]);
			case 'slaPolicies':
				return slaPolicyOptions(raw as SlaPolicy[]);
		}
	}

	async function load(name: CreateCatalogName) {
		const owner = identity;
		if (!owner) return;
		set(name, { ...IDLE, status: 'loading' });
		try {
			const raw = await cache.load(
				CACHE_NAME[name],
				CACHE_FILTERS[name],
				loaders[name] as CatalogLoader<unknown>
			);
			if (tenantKey(identity) !== tenantKey(owner)) return;
			set(name, {
				status: 'ready',
				options: options(name, raw),
				error: null,
				errorMessage: null
			});
		} catch (error) {
			if (isStaleRequest(error) || tenantKey(identity) !== tenantKey(owner)) return;
			const apiError = isApiError(error) ? error : networkApiError();
			// A failure is an error state, never an empty list.
			set(name, {
				status: 'error',
				options: [],
				error: apiError,
				errorMessage: catalogErrorMessage(apiError)
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
		setIdentity(next, names) {
			if (tenantKey(next) !== tenantKey(identity)) {
				identity = next;
				cache.setIdentity(next);
				state = EMPTY_STATE;
				for (const listener of listeners) listener(state);
			}
			for (const name of names) if (state[name].status === 'idle') void load(name);
		},
		async retry(name) {
			if (state[name].status !== 'error') return;
			await load(name);
		},
		dispose() {
			cache.dispose();
			listeners.clear();
			identity = null;
			state = EMPTY_STATE;
		}
	};
}
