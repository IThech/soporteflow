import type {
	ActiveOrganizationContext,
	AuthenticatedUserContext,
	AuthUserProfile,
	GetMeOptions,
	UserOrganizationSummary
} from '../api/auth.ts';
import { ApiError, isApiError, networkApiError } from '../api/errors.ts';
import { createRequestScope, isStaleRequest } from './request-scope.ts';

/**
 * Organization context of the /app tree (UI-1A, A3, FE-02).
 *
 * Single source of truth for user, organizations, the active organization and its REAL
 * capabilities (from /api/me?organizationId=…). Svelte-store compatible (`subscribe`), created
 * per /app layout instance (setContext) — never a module-level singleton, never written from SSR.
 *
 * Organization precedence:
 * 1. explicit organizationId (URL) — must belong to the user's organizations; if it does not,
 *    status 'invalid-organization' and NOTHING is substituted silently;
 * 2. remembered selection (sessionStorage) — only if still valid;
 * 3. the only organization;
 * 4. otherwise 'selection-required'.
 *
 * Tenant switching: every change of user/organization bumps `generation` and `contextKey`,
 * clears capabilities immediately and aborts/ignores older responses (request-scope.ts), so a
 * late answer (data, capabilities or a 401) from the previous context can never land in the new
 * one. Consumers reset their own tenant data when `contextKey` changes.
 */

export type OrganizationContextStatus =
	| 'idle'
	| 'loading'
	| 'ready'
	| 'selection-required'
	| 'invalid-organization'
	| 'no-organizations'
	| 'forbidden'
	| 'unauthenticated'
	| 'error';

export interface OrganizationContextState {
	status: OrganizationContextStatus;
	user: AuthUserProfile | null;
	organizations: readonly UserOrganizationSummary[];
	activeOrganizationId: string | null;
	activeOrganization: ActiveOrganizationContext | null;
	capabilities: readonly string[];
	/** Explicit organization id that was rejected (status 'invalid-organization'). */
	rejectedOrganizationId: string | null;
	error: ApiError | null;
	/** `<userId>:<organizationId>` of the context whose data may be shown ('' when none). */
	contextKey: string;
	/** Bumped on every context change; consumers drop tenant data when it changes. */
	generation: number;
}

export interface SelectionStorage {
	read(): string | null;
	write(organizationId: string | null): void;
}

export type GetMe = (
	customFetch: typeof fetch,
	options?: GetMeOptions
) => Promise<AuthenticatedUserContext>;

export interface OrganizationContextDependencies {
	getMe: GetMe;
	fetch?: typeof fetch;
	storage?: SelectionStorage;
	/** Compatibility hook (legacy session store); called only for current, successful loads. */
	onActivated?: (me: AuthenticatedUserContext, organizationId: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ORGANIZATION_SELECTION_KEY = 'soporteflow.activeOrganizationId';

export function sessionSelectionStorage(): SelectionStorage {
	return {
		read() {
			try {
				return typeof window === 'undefined'
					? null
					: window.sessionStorage.getItem(ORGANIZATION_SELECTION_KEY);
			} catch {
				return null;
			}
		},
		write(organizationId) {
			try {
				if (typeof window === 'undefined') return;
				if (organizationId === null) window.sessionStorage.removeItem(ORGANIZATION_SELECTION_KEY);
				else window.sessionStorage.setItem(ORGANIZATION_SELECTION_KEY, organizationId);
			} catch {
				/* storage is optional */
			}
		}
	};
}

const INITIAL: OrganizationContextState = {
	status: 'idle',
	user: null,
	organizations: [],
	activeOrganizationId: null,
	activeOrganization: null,
	capabilities: [],
	rejectedOrganizationId: null,
	error: null,
	contextKey: '',
	generation: 0
};

export interface OrganizationContext {
	subscribe(run: (state: OrganizationContextState) => void): () => void;
	get(): OrganizationContextState;
	/** (Re)loads identity and resolves the organization; `explicitOrganizationId` from the URL. */
	load(explicitOrganizationId: string | null): Promise<void>;
	/** User choice from the selector; false if the id is not one of the user's organizations. */
	selectOrganization(organizationId: string): Promise<boolean>;
	/** Unmount / sign-out: abort everything and forget tenant state. */
	dispose(): void;
}

function toApiError(error: unknown): ApiError {
	return isApiError(error) ? error : networkApiError();
}

export function createOrganizationContext(
	deps: OrganizationContextDependencies
): OrganizationContext {
	let state: OrganizationContextState = { ...INITIAL };
	const listeners = new Set<(s: OrganizationContextState) => void>();
	const scope = createRequestScope();
	const storage = deps.storage ?? { read: () => null, write: () => {} };
	const baseFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

	function set(patch: Partial<OrganizationContextState>) {
		state = { ...state, ...patch };
		for (const listener of listeners) listener(state);
	}
	const withSignal =
		(signal: AbortSignal): typeof fetch =>
		(input, init) =>
			baseFetch(input, { ...init, signal });

	function fail(error: unknown) {
		const apiError = toApiError(error);
		set({
			status: apiError.status === 401 ? 'unauthenticated' : 'error',
			error: apiError,
			activeOrganization: null,
			capabilities: []
		});
	}

	/** Switches to `organizationId` and loads its capabilities (tenant data is invalidated first). */
	async function activate(
		me: AuthenticatedUserContext,
		organizationId: string,
		source: 'explicit' | 'remembered' | 'single' | 'user'
	): Promise<void> {
		const contextKey = `${me.user.id}:${organizationId}`;
		scope.setContext(contextKey);
		set({
			status: 'loading',
			activeOrganizationId: organizationId,
			activeOrganization: null,
			capabilities: [],
			rejectedOrganizationId: null,
			error: null,
			contextKey,
			generation: state.generation + 1
		});
		let withOrg: AuthenticatedUserContext;
		try {
			withOrg = await scope.run((signal) => deps.getMe(withSignal(signal), { organizationId }));
		} catch (error) {
			if (isStaleRequest(error)) return;
			const apiError = toApiError(error);
			if (apiError.status === 403 && source === 'remembered') {
				// A remembered selection that is no longer operational is forgotten, not substituted.
				storage.write(null);
				set({
					status: 'selection-required',
					activeOrganizationId: null,
					contextKey: '',
					generation: state.generation + 1,
					error: null
				});
				scope.setContext('');
				return;
			}
			if (apiError.status === 403) {
				set({ status: 'forbidden', error: apiError, capabilities: [], activeOrganization: null });
				return;
			}
			fail(apiError);
			return;
		}
		const active = withOrg.activeOrganization;
		if (!active || active.id !== organizationId) {
			fail(
				new ApiError(200, 'INVALID_PAYLOAD', 'No se pudo interpretar la respuesta del servidor.')
			);
			return;
		}
		storage.write(organizationId);
		set({
			status: 'ready',
			user: withOrg.user,
			organizations: withOrg.organizations,
			activeOrganization: active,
			capabilities: [...active.capabilities],
			error: null
		});
		deps.onActivated?.(withOrg, organizationId);
	}

	const context: OrganizationContext = {
		subscribe(run) {
			listeners.add(run);
			run(state);
			return () => listeners.delete(run);
		},
		get: () => state,
		async load(explicitOrganizationId) {
			scope.setContext('');
			set({
				...INITIAL,
				status: 'loading',
				user: state.user,
				organizations: state.organizations,
				generation: state.generation + 1
			});
			let me: AuthenticatedUserContext;
			try {
				me = await scope.run((signal) => deps.getMe(withSignal(signal)));
			} catch (error) {
				if (isStaleRequest(error)) return;
				set({ user: null, organizations: [] });
				fail(error);
				return;
			}
			const organizations = Array.isArray(me?.organizations) ? me.organizations : [];
			set({ user: me.user, organizations });
			if (explicitOrganizationId !== null) {
				const valid =
					UUID.test(explicitOrganizationId) &&
					organizations.some((org) => org.id === explicitOrganizationId);
				if (!valid) {
					set({ status: 'invalid-organization', rejectedOrganizationId: explicitOrganizationId });
					return;
				}
				return activate(me, explicitOrganizationId, 'explicit');
			}
			const remembered = storage.read();
			if (remembered && organizations.some((org) => org.id === remembered))
				return activate(me, remembered, 'remembered');
			if (remembered) storage.write(null);
			if (organizations.length === 1) return activate(me, organizations[0].id, 'single');
			set({ status: organizations.length === 0 ? 'no-organizations' : 'selection-required' });
		},
		async selectOrganization(organizationId) {
			const me = { user: state.user, organizations: state.organizations };
			if (!me.user || !state.organizations.some((org) => org.id === organizationId)) return false;
			await activate(me as AuthenticatedUserContext, organizationId, 'user');
			return true;
		},
		dispose() {
			scope.invalidate();
			scope.setContext('');
			listeners.clear();
			state = { ...INITIAL };
		}
	};
	return context;
}
