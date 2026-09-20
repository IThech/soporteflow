import { and, eq } from 'drizzle-orm';
import { resolvePrincipal } from './principal';
import { getDb } from '../db';
import {
	users,
	organizations,
	memberships,
	roles,
	roleAssignments,
	rolePermissions,
	permissions,
	departments,
	teams,
	sites
} from '../db/schema';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
export type OrganizationMembership = Readonly<{
	userId: string;
	organizationId: string;
	membershipId: string;
}>;
export type AuthorizationResource = Readonly<{ kind: 'department' | 'team' | 'site'; id: string }>;
export type PermissionGrant = Readonly<{
	roleId: string;
	permissionId: string;
	scope: 'organization' | 'department' | 'team' | 'site';
	resourceId: string | null;
}>;
export type AuthorizationAction = Readonly<{
	organizationId: string;
	permissionId: string;
	resource?: AuthorizationResource;
}>;

/** Internal only: membership is derived from a freshly resolved server identity. */
async function membership(
	headers: Headers,
	organizationId: string
): Promise<OrganizationMembership | null> {
	if (!(headers instanceof Headers) || !validId(organizationId)) return null;
	const principal = await resolvePrincipal(headers);
	if (!principal || !validId(principal.userId)) return null;
	const [row] = await getDb()
		.select({ userId: users.id, organizationId: organizations.id, membershipId: memberships.id })
		.from(memberships)
		.innerJoin(users, eq(users.id, memberships.userId))
		.innerJoin(organizations, eq(organizations.id, memberships.organizationId))
		.where(
			and(
				eq(memberships.organizationId, organizationId),
				eq(memberships.userId, principal.userId),
				eq(users.active, true),
				eq(memberships.active, true),
				eq(organizations.status, 'active')
			)
		)
		.limit(1);
	return row ? Object.freeze(row) : null;
}
/** Membership is not permission to execute a business action. */
export async function verifyOrganizationMembership(
	headers: Headers,
	organizationId: string
): Promise<OrganizationMembership | null> {
	try {
		return await membership(headers, organizationId);
	} catch {
		return null;
	}
}

/** No unscoped resource query and no resource objects accepted from the caller. */
async function resourceExists(
	organizationId: string,
	resource: AuthorizationResource
): Promise<boolean> {
	if (!resource || !validId(resource.id)) return false;
	const table =
		resource.kind === 'department'
			? departments
			: resource.kind === 'team'
				? teams
				: resource.kind === 'site'
					? sites
					: null;
	if (!table) return false;
	const [row] = await getDb()
		.select({ id: table.id })
		.from(table)
		.where(
			and(
				eq(table.organizationId, organizationId),
				eq(table.id, resource.id),
				eq(table.active, true)
			)
		)
		.limit(1);
	return !!row;
}

async function grants(
	context: OrganizationMembership,
	permissionId?: string
): Promise<PermissionGrant[]> {
	const rows = await getDb()
		.select({
			roleId: roles.id,
			permissionId: permissions.id,
			allowedScopes: permissions.allowedScopeTypes,
			scope: roleAssignments.scopeType,
			departmentId: roleAssignments.departmentId,
			teamId: roleAssignments.teamId,
			siteId: roleAssignments.siteId
		})
		.from(roleAssignments)
		.innerJoin(
			roles,
			and(
				eq(roles.id, roleAssignments.roleId),
				eq(roles.organizationId, roleAssignments.organizationId)
			)
		)
		.innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
		.innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
		.where(
			and(
				eq(roleAssignments.organizationId, context.organizationId),
				eq(roles.organizationId, context.organizationId),
				eq(roleAssignments.membershipId, context.membershipId),
				eq(roles.active, true),
				permissionId === undefined ? undefined : eq(permissions.id, permissionId)
			)
		);
	const result: PermissionGrant[] = [];
	for (const row of rows) {
		// No platform authority or inheritance from role templates/names.
		if (row.permissionId.startsWith('platform:') || !row.allowedScopes.includes(row.scope))
			continue;
		if (row.scope === 'organization') {
			result.push(
				Object.freeze({
					roleId: row.roleId,
					permissionId: row.permissionId,
					scope: 'organization',
					resourceId: null
				})
			);
		} else if (row.scope === 'department' || row.scope === 'team' || row.scope === 'site') {
			const id =
				row.scope === 'department'
					? row.departmentId
					: row.scope === 'team'
						? row.teamId
						: row.siteId;
			if (id && (await resourceExists(context.organizationId, { kind: row.scope, id }))) {
				result.push(
					Object.freeze({
						roleId: row.roleId,
						permissionId: row.permissionId,
						scope: row.scope,
						resourceId: id
					})
				);
			}
		}
		// personal has no supported resource-ownership relation in the current Core.
	}
	return result;
}
/** Informational grants, never a reusable authorization token or cached decision. */
export async function resolveOrganizationPermissions(
	headers: Headers,
	organizationId: string
): Promise<PermissionGrant[]> {
	try {
		const context = await membership(headers, organizationId);
		return context ? await grants(context) : [];
	} catch {
		return [];
	}
}
/** The permission key must be selected by server business code, not by a client form. */
export async function authorizeAction(
	headers: Headers,
	action: AuthorizationAction
): Promise<boolean> {
	try {
		if (
			!action ||
			typeof action.permissionId !== 'string' ||
			!action.permissionId ||
			action.permissionId.length > 100
		)
			return false;
		const context = await membership(headers, action.organizationId);
		if (!context) return false;
		if (
			action.resource !== undefined &&
			!(await resourceExists(context.organizationId, action.resource))
		)
			return false;
		const applicable = await grants(context, action.permissionId);
		return applicable.some(
			(grant) =>
				grant.scope === 'organization' ||
				(action.resource !== undefined &&
					grant.scope === action.resource.kind &&
					grant.resourceId === action.resource.id)
		);
	} catch {
		// Do not disclose whether another tenant's resource exists or leak database errors.
		return false;
	}
}
