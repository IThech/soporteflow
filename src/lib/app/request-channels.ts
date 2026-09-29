import { createRequestScope, type RequestScope } from './request-scope.ts';

/**
 * UI-2A — independent request channels over the UI-1 request scope.
 *
 * `RequestScope.begin()` aborts the previous request OF THE SAME SCOPE (latest wins). Parallel
 * resources of one screen (detail, comments, internal notes, history, each catalog) therefore
 * need one scope each: sharing a single scope would make a valid request cancel another one.
 * A channel set gives every name its own scope while a context switch (or invalidation) reaches
 * all of them at once, so no channel can outlive the tenant/incident it was started for.
 */
export interface RequestChannels {
	/** The scope of `name` (created on first use, already in the current context). */
	channel(name: string): RequestScope;
	/** Context switch for every channel: in-flight work aborted, older tickets stale. */
	setContext(contextKey: string): void;
	readonly contextKey: string;
	/** Aborts everything and makes every ticket stale (unmount / sign-out). */
	invalidate(): void;
}

export function createRequestChannels(initialContextKey = ''): RequestChannels {
	let contextKey = initialContextKey;
	const scopes = new Map<string, RequestScope>();
	return {
		channel(name) {
			let scope = scopes.get(name);
			if (!scope) {
				scope = createRequestScope(contextKey);
				scopes.set(name, scope);
			}
			return scope;
		},
		setContext(next) {
			if (next === contextKey) return;
			contextKey = next;
			for (const scope of scopes.values()) scope.setContext(next);
		},
		get contextKey() {
			return contextKey;
		},
		invalidate() {
			for (const scope of scopes.values()) scope.invalidate();
		}
	};
}
