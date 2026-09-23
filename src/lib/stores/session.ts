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
			// Rule: Only auto-select if strictly 1 active organization exists.
			// 0 or 2+ organizations -> activeOrganization is strictly null until explicit selection.
			const activeOrganization =
				context.organizations.length === 1 ? context.organizations[0] : null;

			set({
				user: context.user,
				organizations: context.organizations,
				activeOrganization,
				isAuthenticated: true,
				isLoading: false,
				error: null
			});
		},
		clearSession: () => {
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
			set(initialState);
		}
	};
}

export const session = createSessionStore();
