import { and, eq, asc } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { teams } from '../db/schema';
import { IncidentServiceError } from './incidents';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TeamDatabase = PgDatabase<any, any>;

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && uuidRegex.test(value);
}

export interface ActiveTeamRecord {
	id: string;
	name: string;
	description: string | null;
}

/**
 * Retrieves active teams for a specific organization from the real database.
 * Filters strictly by organizationId and active = true.
 * Returns deterministic ordering: name ASC, id ASC.
 */
export async function getActiveTeams(
	db: TeamDatabase,
	organizationId: string
): Promise<ActiveTeamRecord[]> {
	if (!isValidUuid(organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}

	const rows = await db
		.select({
			id: teams.id,
			name: teams.name,
			description: teams.description
		})
		.from(teams)
		.where(and(eq(teams.organizationId, organizationId), eq(teams.active, true)))
		.orderBy(asc(teams.name), asc(teams.id));

	return rows;
}
