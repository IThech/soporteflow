import { and, eq, asc } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { users, authUsers, memberships, organizations } from '../db/schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UserContextDatabase = PgDatabase<any, any>;

export interface AuthenticatedUserProfile {
	readonly id: string;
	readonly name: string;
	readonly email: string;
}

export interface UserOrganizationSummary {
	readonly id: string;
	readonly name: string;
	readonly slug: string;
}

export interface AuthenticatedUserContext {
	readonly user: AuthenticatedUserProfile;
	readonly organizations: UserOrganizationSummary[];
}

export type UserContextServiceErrorCode =
	'INVALID_INPUT' | 'USER_NOT_FOUND' | 'AUTH_PROFILE_INCONSISTENT';

export class UserContextServiceError extends Error {
	constructor(
		readonly code: UserContextServiceErrorCode,
		message: string
	) {
		super(message);
		this.name = 'UserContextServiceError';
	}
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID_REGEX.test(value);
}

/**
 * Retrieves the minimal authenticated user context for client bootstrap:
 * 1. Public user profile (id, name, real email from auth_users).
 * 2. Active organizations where the user holds an active membership.
 *
 * Operational invariants:
 * - Excludes non-operational organizations ('trial', 'suspended').
 * - Deterministically sorted by organization name ASC, id ASC.
 * - Does NOT auto-select any organization on the server.
 * - Throws UserContextServiceError('AUTH_PROFILE_INCONSISTENT') if auth_users is missing or email is absent.
 */
export async function getAuthenticatedUserContext(
	db: UserContextDatabase,
	userId: string
): Promise<AuthenticatedUserContext> {
	if (!isValidUuid(userId)) {
		throw new UserContextServiceError('INVALID_INPUT', 'userId must be a valid UUID');
	}

	// 1. Fetch user from core users table
	const [userRow] = await db
		.select({
			id: users.id,
			name: users.name,
			active: users.active
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);

	if (!userRow || !userRow.active) {
		throw new UserContextServiceError('USER_NOT_FOUND', 'User record not found or inactive');
	}

	// 2. Fetch email from auth_users access profile
	const [authProfile] = await db
		.select({
			email: authUsers.email
		})
		.from(authUsers)
		.where(eq(authUsers.id, userId))
		.limit(1);

	if (!authProfile || typeof authProfile.email !== 'string' || authProfile.email.trim() === '') {
		throw new UserContextServiceError(
			'AUTH_PROFILE_INCONSISTENT',
			'Authenticated user has no matching auth profile or email is missing'
		);
	}

	// 3. Fetch active organizations for active memberships
	const orgRows = await db
		.select({
			id: organizations.id,
			name: organizations.name,
			slug: organizations.slug
		})
		.from(memberships)
		.innerJoin(organizations, eq(organizations.id, memberships.organizationId))
		.where(
			and(
				eq(memberships.userId, userId),
				eq(memberships.active, true),
				eq(organizations.status, 'active')
			)
		)
		.orderBy(asc(organizations.name), asc(organizations.id));

	return {
		user: {
			id: userRow.id,
			name: userRow.name,
			email: authProfile.email
		},
		organizations: orgRows
	};
}
