import { getContext, setContext } from 'svelte';
import { getMe } from '../api/auth.ts';
import { session } from '../stores/session.ts';
import {
	createOrganizationContext,
	sessionSelectionStorage,
	type OrganizationContext
} from './organization-context.ts';

/**
 * Svelte wiring of the organization context (UI-1A). The /app layout provides ONE instance per
 * layout mount (native Svelte context: no module singleton, SSR-safe). Nothing loads during SSR:
 * pages call `load` from client effects.
 *
 * Compatibility (A4): the legacy session store stays as a facade for pages not yet migrated
 * (demo, incident detail/new). It receives identity + active organization only; capabilities
 * live exclusively here (single source of truth).
 */
const KEY = Symbol('sf-organization-context');

export function provideOrganizationContext(): OrganizationContext {
	const context = createOrganizationContext({
		getMe,
		storage: sessionSelectionStorage(),
		onActivated(me, organizationId) {
			session.setSession({ user: me.user, organizations: me.organizations });
			session.setActiveOrganization(organizationId);
		}
	});
	setContext(KEY, context);
	return context;
}

export function useOrganizationContext(): OrganizationContext {
	const context = getContext<OrganizationContext | undefined>(KEY);
	if (!context) throw new Error('Organization context is only available inside /app');
	return context;
}
