import { writable } from 'svelte/store';
import type {
	AuthUserProfile,
	UserOrganizationSummary,
	AuthenticatedUserContext
} from '$lib/api/auth';

export interface SessionState {
	user: AuthUserProfile | null;
	organizations: UserOrganizationSummary[];
	activeOrganization: UserOrganizationSummary | null;
	isAuthenticated: boolean;
	isLoading: boolean;
	error: string | null;
}

const initialState: SessionState = {
	user: null,
	organizations: [],
	activeOrganization: null,
	isAuthenticated: false,
	isLoading: false,
	error: null
};

const selectionKey = 'soporteflow.activeOrganizationId';
function readSelection(): string | null {
	try {
		return typeof window === 'undefined' ? null : window.sessionStorage.getItem(selectionKey);
	} catch {
		return null;
	}
}
function persistSelection(id: string | null): void {
	try {
		if (typeof window === 'undefined') return;
		if (id === null) window.sessionStorage.removeItem(selectionKey);
		else window.sessionStorage.setItem(selectionKey, id);
	} catch {
		/* Storage is optional; the in-memory selection remains usable. */
	}
}
function createSessionStore() {
	const { subscribe, set, update } = writable<SessionState>(initialState);

	return {
		subscribe,
		setLoading: (isLoading: boolean) => {
			update((state) => ({ ...state, isLoading }));
		},
		setError: (error: string | null) => {
			update((state) => ({ ...state, error, isLoading: false }));
		},
		setSession: (context: AuthenticatedUserContext) => {
			// Restore only against fresh organizations returned by /api/me.
			const rememberedId = readSelection();
			const activeOrganization =
				context.organizations.length === 1
					? context.organizations[0]
					: (context.organizations.find((org) => org.id === rememberedId) ?? null);
			persistSelection(activeOrganization?.id ?? null);

			set({
				user: context.user,
				organizations: context.organizations,
				activeOrganization,
				isAuthenticated: true,
				isLoading: false,
				error: null
			});
		},
		setActiveOrganization: (organizationId: string): boolean => {
			let selected = false;
			update((state) => {
				if (!state.isAuthenticated || typeof organizationId !== 'string') return state;
				const organization = state.organizations.find((org) => org.id === organizationId);
				if (!organization) return state;
				persistSelection(organization.id);
				selected = true;
				return { ...state, activeOrganization: organization };
			});
			return selected;
		},
		clearSession: () => {
			persistSelection(null);
			set({
				user: null,
				organizations: [],
				activeOrganization: null,
				isAuthenticated: false,
				isLoading: false,
				error: null
			});
		},
		reset: () => {
			persistSelection(null);
			set(initialState);
		}
	};
}

export const session = createSessionStore();
