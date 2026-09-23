import { and, eq, desc, asc, isNull, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
	incidents,
	incidentHistory,
	organizationCounters,
	organizations,
	memberships,
	users,
	sites
} from '../db/schema';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IncidentDatabase = PgDatabase<any, any>;

export type IncidentRecord = typeof incidents.$inferSelect;
export type IncidentHistoryRecord = typeof incidentHistory.$inferSelect;

export type IncidentPriority = 'low' | 'medium' | 'high' | 'urgent';
export type IncidentStatus = 'open' | 'pending' | 'resolved' | 'closed';

const VALID_PRIORITIES = new Set<IncidentPriority>(['low', 'medium', 'high', 'urgent']);
const VALID_STATUSES = new Set<IncidentStatus>(['open', 'pending', 'resolved', 'closed']);

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && uuidRegex.test(value);
}

export type IncidentServiceErrorCode =
	| 'ORGANIZATION_NOT_FOUND'
	| 'ORGANIZATION_NOT_OPERATIONAL'
	| 'CREATOR_MEMBERSHIP_NOT_FOUND'
	| 'CREATOR_MEMBERSHIP_INACTIVE'
	| 'CREATOR_USER_INACTIVE'
	| 'CLIENT_USER_MEMBERSHIP_NOT_FOUND'
	| 'CLIENT_USER_INACTIVE'
	| 'SITE_NOT_FOUND'
	| 'SITE_INACTIVE'
	| 'INVALID_INPUT';

export class IncidentServiceError extends Error {
	constructor(
		readonly code: IncidentServiceErrorCode,
		message: string
	) {
		super(message);
		this.name = 'IncidentServiceError';
	}
}

export interface IncidentServiceContext {
	readonly organizationId: string;
	readonly creatorUserId: string;
}

export interface CreateIncidentInput {
	title: string;
	description: string;
	client: string;
	priority?: IncidentPriority;
	clientUserId?: string | null;
	siteId?: string | null;
}

export interface CreateIncidentResult {
	incident: IncidentRecord;
	history: IncidentHistoryRecord;
}

export interface ListIncidentsFilters {
	status?: IncidentStatus;
	priority?: IncidentPriority;
	siteId?: string | null;
}

export interface IncidentDetail {
	incident: IncidentRecord;
	history: IncidentHistoryRecord[];
}

/**
 * Creates a new incident within a single atomic Drizzle transaction.
 * Validates active tenant, active creator membership, input integrity,
 * optional client user membership/activity, optional site tenant/activity,
 * increments the sequential counter atomically, inserts the incident with
 * server-imposed 'open' status, and records the initial 'created' audit event.
 */
export async function createIncidentRecord(
	dbOrTx: IncidentDatabase,
	context: IncidentServiceContext,
	input: CreateIncidentInput
): Promise<CreateIncidentResult> {
	// 1. Context validation (trusted server context)
	if (!isValidUuid(context?.organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}
	if (!isValidUuid(context?.creatorUserId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'creatorUserId must be a valid UUID');
	}

	// 2. Input validation
	if (typeof input?.title !== 'string' || input.title.trim().length === 0) {
		throw new IncidentServiceError('INVALID_INPUT', 'title must be a non-empty string');
	}
	if (input.title.trim().length > 255) {
		throw new IncidentServiceError('INVALID_INPUT', 'title must not exceed 255 characters');
	}

	if (typeof input?.description !== 'string' || input.description.trim().length === 0) {
		throw new IncidentServiceError('INVALID_INPUT', 'description must be a non-empty string');
	}

	if (typeof input?.client !== 'string' || input.client.trim().length === 0) {
		throw new IncidentServiceError('INVALID_INPUT', 'client must be a non-empty string');
	}
	if (input.client.trim().length > 255) {
		throw new IncidentServiceError('INVALID_INPUT', 'client must not exceed 255 characters');
	}

	const priority: IncidentPriority = input.priority ?? 'medium';
	if (!VALID_PRIORITIES.has(priority)) {
		throw new IncidentServiceError('INVALID_INPUT', `invalid priority '${String(input.priority)}'`);
	}

	if (
		input.clientUserId !== undefined &&
		input.clientUserId !== null &&
		!isValidUuid(input.clientUserId)
	) {
		throw new IncidentServiceError('INVALID_INPUT', 'clientUserId must be a valid UUID');
	}

	if (input.siteId !== undefined && input.siteId !== null && !isValidUuid(input.siteId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'siteId must be a valid UUID');
	}

	// 3. Single atomic transaction execution
	const execute = async (tx: IncidentDatabase): Promise<CreateIncidentResult> => {
		// A. Validate Organization existence & operational status ('active' strictly required)
		const [org] = await tx
			.select({ id: organizations.id, status: organizations.status })
			.from(organizations)
			.where(eq(organizations.id, context.organizationId))
			.limit(1);

		if (!org) {
			throw new IncidentServiceError('ORGANIZATION_NOT_FOUND', 'Organization does not exist');
		}

		if (org.status !== 'active') {
			throw new IncidentServiceError(
				'ORGANIZATION_NOT_OPERATIONAL',
				`Organization is not operational (status: '${org.status}')`
			);
		}

		// B. Validate Creator Membership and User activity
		const [creatorRecord] = await tx
			.select({
				membershipActive: memberships.active,
				userActive: users.active
			})
			.from(memberships)
			.innerJoin(users, eq(users.id, memberships.userId))
			.where(
				and(
					eq(memberships.organizationId, context.organizationId),
					eq(memberships.userId, context.creatorUserId)
				)
			)
			.limit(1);

		if (!creatorRecord) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_NOT_FOUND',
				'Creator has no membership in this organization'
			);
		}

		if (!creatorRecord.membershipActive) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_INACTIVE',
				'Creator membership in this organization is inactive'
			);
		}

		if (!creatorRecord.userActive) {
			throw new IncidentServiceError(
				'CREATOR_USER_INACTIVE',
				'Creator user account is globally inactive'
			);
		}

		// C. Validate optional clientUserId (must belong to tenant and be active)
		if (input.clientUserId) {
			const [clientRecord] = await tx
				.select({
					membershipActive: memberships.active,
					userActive: users.active
				})
				.from(memberships)
				.innerJoin(users, eq(users.id, memberships.userId))
				.where(
					and(
						eq(memberships.organizationId, context.organizationId),
						eq(memberships.userId, input.clientUserId)
					)
				)
				.limit(1);

			if (!clientRecord) {
				throw new IncidentServiceError(
					'CLIENT_USER_MEMBERSHIP_NOT_FOUND',
					'Client user has no membership in this organization'
				);
			}

			if (!clientRecord.membershipActive || !clientRecord.userActive) {
				throw new IncidentServiceError(
					'CLIENT_USER_INACTIVE',
					'Client user account or membership is inactive'
				);
			}
		}

		// D. Validate optional siteId (must belong to tenant and be active)
		if (input.siteId) {
			const [siteRecord] = await tx
				.select({
					id: sites.id,
					organizationId: sites.organizationId,
					active: sites.active
				})
				.from(sites)
				.where(eq(sites.id, input.siteId))
				.limit(1);

			if (!siteRecord || siteRecord.organizationId !== context.organizationId) {
				throw new IncidentServiceError(
					'SITE_NOT_FOUND',
					'Site does not exist or belongs to another organization'
				);
			}

			if (!siteRecord.active) {
				throw new IncidentServiceError('SITE_INACTIVE', 'Site is inactive');
			}
		}

		// E. Atomic counter increment via PostgreSQL UPSERT
		const [counter] = await tx
			.insert(organizationCounters)
			.values({
				organizationId: context.organizationId,
				lastIncidentNumber: 1
			})
			.onConflictDoUpdate({
				target: organizationCounters.organizationId,
				set: {
					lastIncidentNumber: sql`${organizationCounters.lastIncidentNumber} + 1`,
					updatedAt: sql`now()`
				}
			})
			.returning({ lastIncidentNumber: organizationCounters.lastIncidentNumber });

		const incidentNumber = counter.lastIncidentNumber;

		// F. Insert Incident (initial status forced server-side to 'open')
		const [incident] = await tx
			.insert(incidents)
			.values({
				organizationId: context.organizationId,
				incidentNumber,
				title: input.title.trim(),
				description: input.description.trim(),
				client: input.client.trim(),
				status: 'open',
				priority,
				clientUserId: input.clientUserId ?? null,
				createdByUserId: context.creatorUserId,
				siteId: input.siteId ?? null
			})
			.returning();

		// G. Insert append-only History event
		const [history] = await tx
			.insert(incidentHistory)
			.values({
				incidentId: incident.id,
				organizationId: context.organizationId,
				eventType: 'created',
				actorType: 'user',
				actorUserId: context.creatorUserId,
				payload: {
					incidentNumber: incident.incidentNumber,
					title: incident.title,
					status: incident.status,
					priority: incident.priority,
					client: incident.client,
					clientUserId: incident.clientUserId,
					siteId: incident.siteId
				}
			})
			.returning();

		return { incident, history };
	};

	if ('transaction' in dbOrTx && typeof dbOrTx.transaction === 'function') {
		return await dbOrTx.transaction(async (tx) => execute(tx));
	}
	return await execute(dbOrTx);
}

/**
 * Lists incidents strictly scoped to the specified organizationId.
 * Supports optional filtering by status, priority, and siteId.
 * Results are returned in deterministic order (createdAt DESC, incidentNumber DESC).
 */
export async function listIncidents(
	db: IncidentDatabase,
	context: { organizationId: string },
	filters?: ListIncidentsFilters
): Promise<IncidentRecord[]> {
	if (!isValidUuid(context?.organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}

	const conditions = [eq(incidents.organizationId, context.organizationId)];

	if (filters?.status) {
		if (!VALID_STATUSES.has(filters.status)) {
			throw new IncidentServiceError(
				'INVALID_INPUT',
				`invalid status filter '${String(filters.status)}'`
			);
		}
		conditions.push(eq(incidents.status, filters.status));
	}

	if (filters?.priority) {
		if (!VALID_PRIORITIES.has(filters.priority)) {
			throw new IncidentServiceError(
				'INVALID_INPUT',
				`invalid priority filter '${String(filters.priority)}'`
			);
		}
		conditions.push(eq(incidents.priority, filters.priority));
	}

	if (filters?.siteId !== undefined) {
		if (filters.siteId === null) {
			conditions.push(isNull(incidents.siteId));
		} else {
			if (!isValidUuid(filters.siteId)) {
				throw new IncidentServiceError('INVALID_INPUT', 'siteId filter must be a valid UUID');
			}
			conditions.push(eq(incidents.siteId, filters.siteId));
		}
	}

	return await db
		.select()
		.from(incidents)
		.where(and(...conditions))
		.orderBy(desc(incidents.createdAt), desc(incidents.incidentNumber));
}

/**
 * Retrieves an incident by internal UUID and organizationId.
 * Always queries jointly by (id, organizationId) to guarantee tenant isolation.
 * Returns null if the incident does not exist or belongs to another tenant.
 * When found, includes the incident's chronological audit history.
 */
export async function getIncidentById(
	db: IncidentDatabase,
	context: { organizationId: string },
	incidentId: string
): Promise<IncidentDetail | null> {
	if (!isValidUuid(context?.organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}

	if (!isValidUuid(incidentId)) {
		return null;
	}

	const [incident] = await db
		.select()
		.from(incidents)
		.where(and(eq(incidents.id, incidentId), eq(incidents.organizationId, context.organizationId)))
		.limit(1);

	if (!incident) {
		return null;
	}

	const history = await db
		.select()
		.from(incidentHistory)
		.where(
			and(
				eq(incidentHistory.incidentId, incident.id),
				eq(incidentHistory.organizationId, context.organizationId)
			)
		)
		.orderBy(asc(incidentHistory.createdAt), asc(incidentHistory.id));

	return { incident, history };
}
