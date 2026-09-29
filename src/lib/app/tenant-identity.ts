import type { OrganizationContextState } from './organization-context.ts';

/**
 * UI-2A — the identity every tenant-bound resource (detail, channels, catalogs, mutations,
 * drafts) is keyed by: user + organization + organization-context generation.
 *
 * The generation is bumped by the organization context on EVERY activation, so A -> B -> A gives
 * three different identities: a result started under the first A can never be applied under the
 * second one. Capabilities are deliberately not part of the key (they are UI hints, re-read by
 * the server on every request) but travel with it for the action helpers.
 */
export interface TenantIdentity {
	readonly userId: string;
	readonly organizationId: string;
	/** Organization-context generation at activation. */
	readonly generation: number;
	readonly capabilities: readonly string[];
}

/** The identity of a READY organization context; null otherwise (nothing tenant-bound may load). */
export function tenantIdentityOf(state: OrganizationContextState): TenantIdentity | null {
	if (state.status !== 'ready' || !state.user || !state.activeOrganizationId) return null;
	return Object.freeze({
		userId: state.user.id,
		organizationId: state.activeOrganizationId,
		generation: state.generation,
		capabilities: state.capabilities
	});
}

/** Stable key of an identity; '' for none. Two different users/orgs/generations never collide. */
export function tenantKey(identity: TenantIdentity | null): string {
	if (!identity) return '';
	return `u:${identity.userId}|o:${identity.organizationId}|g:${identity.generation}`;
}

export function sameTenant(a: TenantIdentity | null, b: TenantIdentity | null): boolean {
	return tenantKey(a) === tenantKey(b);
}

/**
 * A value (e.g. a creation draft) bound to the tenant it was produced in. `valueFor` returns it
 * only for that same identity: a draft is never silently carried to another organization/user.
 */
export interface TenantBound<T> {
	readonly tenant: string;
	readonly value: T;
}

export function bindToTenant<T>(identity: TenantIdentity, value: T): TenantBound<T> {
	return Object.freeze({ tenant: tenantKey(identity), value });
}

export function valueFor<T>(
	bound: TenantBound<T> | null,
	identity: TenantIdentity | null
): T | null {
	if (!bound || !identity || bound.tenant !== tenantKey(identity)) return null;
	return bound.value;
}
