import { resultLimitFailure } from '$lib/server/security/bounded-read';
import { onlyKeys } from '$lib/server/security/query';
import { json, type RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { resolveEffectivePermissions } from '$lib/server/auth/effective-permissions';
import { getAuthenticatedUserContext } from '$lib/server/services/user-context';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(status: number, code: string, message: string) {
	return json({ error: { code, message } }, { status });
}

/**
 * GET /api/me                          -> { user, organizations } (session bootstrap, unchanged)
 * GET /api/me?organizationId=<UUID>    -> { user, organizations, activeOrganization }
 *   activeOrganization = { id, name, slug, capabilities: PermissionId[] }
 * Capabilities tell the client WHAT it may do (canonical organization-scoped permission ids);
 * never roles, role ids or assignment ids. Authorization is still enforced by every endpoint.
 * An organization that is missing, foreign, suspended or without an active membership yields the
 * same 403 (no enumeration).
 */
export const GET: RequestHandler = async (event) => {
	if (!onlyKeys(event.url.searchParams, ['organizationId']))
		return json({ error: { code: 'INVALID_INPUT', message: 'Invalid request.' } }, { status: 400 });
	// 1. Authenticate with resolvePrincipal using request cookie header
	const principal = await resolvePrincipal(event.request.headers);
	if (!principal) {
		return failure(401, 'UNAUTHORIZED', 'Authentication required.');
	}

	// 2. Optional organization selector: a single valid UUID. W-C rejects other query keys;
	// identity still comes exclusively from the validated session.
	const organizationIds = event.url.searchParams.getAll('organizationId');
	if (
		organizationIds.length > 1 ||
		(organizationIds.length === 1 && !UUID_REGEX.test(organizationIds[0]))
	) {
		return failure(400, 'INVALID_INPUT', 'organizationId must be a single valid UUID.');
	}
	const organizationId = organizationIds[0] ?? null;

	// 3. Obtain user profile and operational organizations using strictly principal.userId
	try {
		const context = await getAuthenticatedUserContext(db, principal.userId);
		if (organizationId === null) {
			return json({ user: context.user, organizations: context.organizations }, { status: 200 });
		}

		// 4. The organization must be one of the principal's accessible organizations
		const organization = context.organizations.find((org) => org.id === organizationId);
		const capabilities = organization
			? await resolveEffectivePermissions(event.request.headers, organizationId)
			: null;
		if (!organization || !capabilities) {
			return failure(403, 'FORBIDDEN', 'Organization not accessible.');
		}
		return json(
			{
				user: context.user,
				organizations: context.organizations,
				activeOrganization: {
					id: organization.id,
					name: organization.name,
					slug: organization.slug,
					capabilities
				}
			},
			{ status: 200 }
		);
	} catch (error) {
		const oversized = resultLimitFailure(error);
		if (oversized) return oversized;
		// Any unexpected failure or internal inconsistency after authentication returns 500
		return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
	}
};
