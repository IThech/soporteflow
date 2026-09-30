import { StaleRequestError } from './request-scope.ts';
import { tenantKey, type TenantIdentity } from './tenant-identity.ts';

/**
 * UI-2A — tenant-bound catalog cache (sites, categories, teams, assignees, memberships, SLA
 * policies) for ONE page/controller. Never a global store and never persisted (no localStorage /
 * sessionStorage): it lives and dies with its owner.
 *
 * - Key: user + organization + context generation + catalog + relevant filters. A cache of
 *   organization A (or user A) can never answer for B, even for the same catalog and filters.
 * - A new identity drops every entry and aborts in-flight loads; their late answers are stale.
 * - Identical concurrent loads share one request (deduplication).
 * - Only successes are cached. A failed load rejects with its error: it is NEVER an empty list
 *   (an empty catalog and an unavailable catalog are different states for the UI).
 * - Catalog endpoints are bounded server-side (boundedRows, 422 above the limit); no pagination
 *   or remote search is invented here.
 */

export type CatalogName =
	'sites' | 'categories' | 'teams' | 'assignees' | 'memberships' | 'slaPolicies' | 'clients';

export type CatalogFilters = Readonly<Record<string, string | number | boolean | null | undefined>>;

export type CatalogLoader<T> = (organizationId: string, signal: AbortSignal) => Promise<T>;

export function catalogKey(
	identity: TenantIdentity,
	catalog: CatalogName,
	filters: CatalogFilters = {}
): string {
	const normalized = Object.keys(filters)
		.filter((key) => filters[key] !== undefined)
		.sort()
		.map((key) => [key, filters[key]]);
	return `${tenantKey(identity)}|c:${catalog}|f:${JSON.stringify(normalized)}`;
}

export interface TenantCatalogCache {
	/** Binds the cache to an identity; a different one (or null) clears everything. */
	setIdentity(identity: TenantIdentity | null): void;
	readonly identity: TenantIdentity | null;
	/** Cached value or one shared load; rejects with the load error (never an empty list). */
	load<T>(catalog: CatalogName, filters: CatalogFilters, loader: CatalogLoader<T>): Promise<T>;
	/** Cached value for the CURRENT identity only. */
	peek<T>(catalog: CatalogName, filters?: CatalogFilters): T | undefined;
	/** Forgets one catalog (every filter variant) or everything, e.g. after a mutation. */
	invalidate(catalog?: CatalogName): void;
	dispose(): void;
}

interface InFlight {
	promise: Promise<unknown>;
	controller: AbortController;
}

export function createTenantCatalogCache(): TenantCatalogCache {
	let identity: TenantIdentity | null = null;
	const values = new Map<string, unknown>();
	const inFlight = new Map<string, InFlight>();

	function clear() {
		for (const entry of inFlight.values()) entry.controller.abort();
		inFlight.clear();
		values.clear();
	}

	return {
		setIdentity(next) {
			if (tenantKey(next) === tenantKey(identity)) return;
			clear();
			identity = next;
		},
		get identity() {
			return identity;
		},
		load<T>(catalog: CatalogName, filters: CatalogFilters, loader: CatalogLoader<T>) {
			const owner = identity;
			if (!owner) return Promise.reject(new StaleRequestError());
			const key = catalogKey(owner, catalog, filters);
			if (values.has(key)) return Promise.resolve(values.get(key) as T);
			const shared = inFlight.get(key);
			if (shared) return shared.promise as Promise<T>;
			const entry: InFlight = { promise: Promise.resolve(), controller: new AbortController() };
			const isCurrent = () =>
				tenantKey(identity) === tenantKey(owner) && inFlight.get(key) === entry;
			inFlight.set(key, entry);
			const promise = (async () => {
				try {
					const value = await loader(owner.organizationId, entry.controller.signal);
					if (!isCurrent()) throw new StaleRequestError();
					values.set(key, value);
					return value;
				} catch (error) {
					if (!isCurrent()) throw new StaleRequestError();
					throw error;
				} finally {
					if (inFlight.get(key) === entry) inFlight.delete(key);
				}
			})();
			entry.promise = promise;
			return promise;
		},
		peek<T>(catalog: CatalogName, filters: CatalogFilters = {}) {
			if (!identity) return undefined;
			return values.get(catalogKey(identity, catalog, filters)) as T | undefined;
		},
		invalidate(catalog) {
			if (!identity) return;
			const prefix = catalog ? `${tenantKey(identity)}|c:${catalog}|` : `${tenantKey(identity)}|`;
			for (const key of [...values.keys()]) if (key.startsWith(prefix)) values.delete(key);
			for (const [key, entry] of [...inFlight.entries()])
				if (key.startsWith(prefix)) {
					entry.controller.abort();
					inFlight.delete(key);
				}
		},
		dispose() {
			clear();
			identity = null;
		}
	};
}
