import { and, eq, desc, asc, isNull, sql } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
	incidents,
	incidentHistory,
	organizationCounters,
	organizations,
	memberships,
	users,
	sites,
	teams,
	teamMemberships,
	roles,
	roleAssignments
} from '../db/schema';
export { getActiveTeams } from './teams';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type IncidentDatabase = PgDatabase<any, any>;

export type IncidentRecord = typeof incidents.$inferSelect;
export type IncidentHistoryRecord = typeof incidentHistory.$inferSelect;

export type IncidentPriority = 'low' | 'medium' | 'high' | 'urgent';
export type IncidentStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type IncidentQueue = 'mine' | 'unassigned' | 'all';
export type SupportLevel = 'N1' | 'N2' | 'N3';

export const VALID_SUPPORT_LEVELS = ['N1', 'N2', 'N3'] as const;

const VALID_PRIORITIES = new Set<IncidentPriority>(['low', 'medium', 'high', 'urgent']);
const VALID_STATUSES = new Set<IncidentStatus>(['open', 'pending', 'resolved', 'closed']);
const VALID_QUEUES = new Set<IncidentQueue>(['mine', 'unassigned', 'all']);
const VALID_SUPPORT_LEVELS_SET = new Set<SupportLevel>(VALID_SUPPORT_LEVELS);

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
	| 'SITE_NAME_DUPLICATE'
	| 'INVALID_INPUT'
	| 'INCIDENT_NOT_FOUND'
	| 'INCIDENT_CLOSED'
	| 'INCIDENT_ACCESS_DENIED'
	| 'ASSIGNEE_NOT_FOUND';

export class IncidentServiceError extends Error {
	constructor(
		readonly code: IncidentServiceErrorCode,
		message: string
	) {
		super(message);
		this.name = 'IncidentServiceError';
	}
}

/**
 * Validates a site for a new association inside the caller's transaction.
 * The lookup is always scoped by id AND organization (cross-tenant and missing sites are
 * indistinguishable). FOR SHARE conflicts with the row lock of a concurrent
 * UPDATE sites SET active = false, so the site cannot be deactivated between this check
 * and the commit that associates it; a deactivation committed first is observed here.
 */
async function lockActiveSite(
	tx: IncidentDatabase,
	organizationId: string,
	siteId: string
): Promise<void> {
	const [site] = await tx
		.select({ active: sites.active })
		.from(sites)
		.where(and(eq(sites.id, siteId), eq(sites.organizationId, organizationId)))
		.limit(1)
		.for('share');
	if (!site) {
		throw new IncidentServiceError(
			'SITE_NOT_FOUND',
			'Site does not exist or belongs to another organization'
		);
	}
	if (!site.active) {
		throw new IncidentServiceError('SITE_INACTIVE', 'Site is inactive');
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
	queue?: IncidentQueue;
	teamId?: string | null;
	supportLevel?: SupportLevel;
}

export type IncidentDetailRecord = IncidentRecord & {
	assignedToUserName: string | null;
	teamName?: string | null;
};

export interface IncidentDetail {
	incident: IncidentDetailRecord;
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

		// D. Validate optional siteId (must belong to tenant and be active), locked until commit
		if (input.siteId) {
			await lockActiveSite(tx, context.organizationId, input.siteId);
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
				supportLevel: 'N1',
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

export interface ListIncidentsContext {
	readonly organizationId: string;
	readonly actorUserId?: string;
}

/**
 * Lists incidents strictly scoped to the specified organizationId.
 * Supports optional filtering by status, priority, siteId, and queue (mine, unassigned, all).
 * Results are returned in deterministic order (createdAt DESC, incidentNumber DESC).
 */
export async function listIncidents(
	db: IncidentDatabase,
	context: ListIncidentsContext,
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

	if (filters?.queue !== undefined) {
		if (!VALID_QUEUES.has(filters.queue)) {
			throw new IncidentServiceError(
				'INVALID_INPUT',
				`invalid queue filter '${String(filters.queue)}'`
			);
		}
		if (filters.queue === 'mine') {
			if (!isValidUuid(context.actorUserId)) {
				throw new IncidentServiceError(
					'INVALID_INPUT',
					'actorUserId must be a valid UUID when filtering by queue=mine'
				);
			}
			conditions.push(eq(incidents.assignedToUserId, context.actorUserId));
		} else if (filters.queue === 'unassigned') {
			conditions.push(isNull(incidents.assignedToUserId));
		}
	}

	if (filters?.teamId !== undefined) {
		if (filters.teamId === null) {
			conditions.push(isNull(incidents.teamId));
		} else {
			if (!isValidUuid(filters.teamId)) {
				throw new IncidentServiceError('INVALID_INPUT', 'teamId filter must be a valid UUID');
			}
			conditions.push(eq(incidents.teamId, filters.teamId));
		}
	}

	if (filters?.supportLevel !== undefined) {
		if (!VALID_SUPPORT_LEVELS_SET.has(filters.supportLevel)) {
			throw new IncidentServiceError(
				'INVALID_INPUT',
				`invalid supportLevel filter '${String(filters.supportLevel)}'`
			);
		}
		conditions.push(eq(incidents.supportLevel, filters.supportLevel));
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
 * History is available only through the separate safe projection service.
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
		.select({
			id: incidents.id,
			organizationId: incidents.organizationId,
			incidentNumber: incidents.incidentNumber,
			title: incidents.title,
			description: incidents.description,
			status: incidents.status,
			priority: incidents.priority,
			client: incidents.client,
			clientUserId: incidents.clientUserId,
			createdByUserId: incidents.createdByUserId,
			siteId: incidents.siteId,
			assignedToUserId: incidents.assignedToUserId,
			teamId: incidents.teamId,
			supportLevel: incidents.supportLevel,
			createdAt: incidents.createdAt,
			updatedAt: incidents.updatedAt,
			assignedToUserName: users.name,
			teamName: teams.name
		})
		.from(incidents)
		.leftJoin(users, eq(users.id, incidents.assignedToUserId))
		.leftJoin(teams, eq(teams.id, incidents.teamId))
		.where(and(eq(incidents.id, incidentId), eq(incidents.organizationId, context.organizationId)))
		.limit(1);

	if (!incident) {
		return null;
	}

	return { incident };
}

const ALLOWED_STATUS_TRANSITIONS: Record<IncidentStatus, ReadonlySet<IncidentStatus>> = {
	open: new Set<IncidentStatus>(['pending', 'resolved']),
	pending: new Set<IncidentStatus>(['open', 'resolved']),
	resolved: new Set<IncidentStatus>(['open', 'closed']),
	closed: new Set<IncidentStatus>(['open'])
};

export interface UpdateIncidentContext {
	readonly organizationId: string;
	readonly actorUserId: string;
}

export interface UpdateIncidentInput {
	status?: IncidentStatus;
	priority?: IncidentPriority;
}

export interface UpdateIncidentResult {
	incident: IncidentRecord;
	history: IncidentHistoryRecord[];
}

/**
 * Updates an incident's status and/or priority atomically within a single Drizzle transaction.
 * Enforces multi-tenant isolation, active tenant and actor membership, status transition matrix,
 * updates updatedAt only on effective change, generates granular audit history records,
 * and handles no-ops gracefully without mutation or history entries.
 */
export async function updateIncidentRecord(
	dbOrTx: IncidentDatabase,
	context: UpdateIncidentContext,
	incidentId: string,
	input: UpdateIncidentInput
): Promise<UpdateIncidentResult> {
	// 1. Context and input validation
	if (!isValidUuid(context?.organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}
	if (!isValidUuid(context?.actorUserId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'actorUserId must be a valid UUID');
	}
	if (!isValidUuid(incidentId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'incidentId must be a valid UUID');
	}

	if (input?.status !== undefined && !VALID_STATUSES.has(input.status)) {
		throw new IncidentServiceError('INVALID_INPUT', `invalid status '${String(input.status)}'`);
	}

	if (input?.priority !== undefined && !VALID_PRIORITIES.has(input.priority)) {
		throw new IncidentServiceError('INVALID_INPUT', `invalid priority '${String(input.priority)}'`);
	}

	const execute = async (tx: IncidentDatabase): Promise<UpdateIncidentResult> => {
		// A. Validate Organization existence & operational status
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

		// B. Validate Actor Membership and User activity
		const [actorRecord] = await tx
			.select({
				membershipActive: memberships.active,
				userActive: users.active
			})
			.from(memberships)
			.innerJoin(users, eq(users.id, memberships.userId))
			.where(
				and(
					eq(memberships.organizationId, context.organizationId),
					eq(memberships.userId, context.actorUserId)
				)
			)
			.limit(1);

		if (!actorRecord) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_NOT_FOUND',
				'Actor user is not a member of this organization'
			);
		}

		if (!actorRecord.membershipActive) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_INACTIVE',
				'Actor user membership is inactive'
			);
		}

		if (!actorRecord.userActive) {
			throw new IncidentServiceError('CREATOR_USER_INACTIVE', 'Actor user account is inactive');
		}

		// C. Query existing incident strictly within tenant
		const [currentIncident] = await tx
			.select()
			.from(incidents)
			.where(
				and(eq(incidents.id, incidentId), eq(incidents.organizationId, context.organizationId))
			)
			.limit(1);

		if (!currentIncident) {
			throw new IncidentServiceError('INCIDENT_NOT_FOUND', 'Incident not found');
		}

		const currentStatus = currentIncident.status as IncidentStatus;
		const currentPriority = currentIncident.priority as IncidentPriority;

		const isStatusSent = input?.status !== undefined;
		const isPrioritySent = input?.priority !== undefined;

		const isStatusChanged = isStatusSent && input.status !== currentStatus;
		const isPriorityChanged = isPrioritySent && input.priority !== currentPriority;

		// D. Validate status transition if status changed
		if (isStatusChanged) {
			const allowedTransitions = ALLOWED_STATUS_TRANSITIONS[currentStatus];
			if (!allowedTransitions || !allowedTransitions.has(input.status!)) {
				throw new IncidentServiceError(
					'INVALID_INPUT',
					`Transition from status '${currentStatus}' to '${input.status}' is not permitted`
				);
			}
		}

		// E. No-op handling: if neither status nor priority effectively changes
		if (!isStatusChanged && !isPriorityChanged) {
			return { incident: currentIncident, history: [] };
		}

		// F. Update incident
		const updateValues: Partial<typeof incidents.$inferInsert> = {
			updatedAt: new Date()
		};

		if (isStatusChanged) {
			updateValues.status = input.status!;
		}

		if (isPriorityChanged) {
			updateValues.priority = input.priority!;
		}

		const [updatedIncident] = await tx
			.update(incidents)
			.set(updateValues)
			.where(
				and(eq(incidents.id, incidentId), eq(incidents.organizationId, context.organizationId))
			)
			.returning();

		// G. Insert audit history events
		const historyRecords: IncidentHistoryRecord[] = [];

		if (isStatusChanged) {
			let statusEventType: 'resolved' | 'closed' | 'reopened' | 'status_changed';
			const oldStatus = currentStatus;
			const newStatus = input.status!;

			if ((oldStatus === 'open' || oldStatus === 'pending') && newStatus === 'resolved') {
				statusEventType = 'resolved';
			} else if (oldStatus === 'resolved' && newStatus === 'closed') {
				statusEventType = 'closed';
			} else if ((oldStatus === 'resolved' || oldStatus === 'closed') && newStatus === 'open') {
				statusEventType = 'reopened';
			} else {
				statusEventType = 'status_changed';
			}

			const [statusHistory] = await tx
				.insert(incidentHistory)
				.values({
					incidentId,
					organizationId: context.organizationId,
					eventType: statusEventType,
					actorType: 'user',
					actorUserId: context.actorUserId,
					reason: null,
					comment: null,
					payload: {
						oldStatus,
						newStatus
					}
				})
				.returning();

			historyRecords.push(statusHistory);
		}

		if (isPriorityChanged) {
			const [priorityHistory] = await tx
				.insert(incidentHistory)
				.values({
					incidentId,
					organizationId: context.organizationId,
					eventType: 'priority_changed',
					actorType: 'user',
					actorUserId: context.actorUserId,
					reason: null,
					comment: null,
					payload: {
						oldPriority: currentPriority,
						newPriority: input.priority!
					}
				})
				.returning();

			historyRecords.push(priorityHistory);
		}

		return { incident: updatedIncident, history: historyRecords };
	};

	if ('transaction' in dbOrTx && typeof dbOrTx.transaction === 'function') {
		return await dbOrTx.transaction(async (tx) => execute(tx));
	}
	return await execute(dbOrTx);
}

export interface AssignableTechnician {
	id: string;
	name: string;
}

/**
 * Retrieves eligible assignable technicians and organization admins for the organization,
 * optionally filtered to members of a specific team.
 * Filters for active memberships, active user accounts, and operational roles.
 * If teamId is specified, also validates that team is active and belongs to org,
 * and user has an active membership in that team.
 * Returns deterministic list sorted by name ASC, id ASC.
 */
export async function getAssignableTechnicians(
	db: IncidentDatabase,
	organizationId: string,
	teamId?: string | null
): Promise<AssignableTechnician[]> {
	if (!isValidUuid(organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}

	if (teamId !== undefined && teamId !== null) {
		if (!isValidUuid(teamId)) {
			throw new IncidentServiceError('INVALID_INPUT', 'teamId must be a valid UUID');
		}

		// Verify target team exists in org and is active
		const [targetTeam] = await db
			.select({ id: teams.id, active: teams.active })
			.from(teams)
			.where(and(eq(teams.id, teamId), eq(teams.organizationId, organizationId)))
			.limit(1);

		if (!targetTeam || !targetTeam.active) {
			return [];
		}

		const rows = await db
			.selectDistinct({
				id: users.id,
				name: users.name
			})
			.from(users)
			.innerJoin(memberships, eq(memberships.userId, users.id))
			.innerJoin(
				roleAssignments,
				and(
					eq(roleAssignments.membershipId, memberships.id),
					eq(roleAssignments.organizationId, organizationId)
				)
			)
			.innerJoin(
				roles,
				and(eq(roles.id, roleAssignments.roleId), eq(roles.organizationId, organizationId))
			)
			.innerJoin(
				teamMemberships,
				and(
					eq(teamMemberships.membershipId, memberships.id),
					eq(teamMemberships.organizationId, organizationId),
					eq(teamMemberships.teamId, teamId),
					eq(teamMemberships.active, true)
				)
			)
			.where(
				and(
					eq(memberships.organizationId, organizationId),
					eq(memberships.active, true),
					eq(users.active, true),
					eq(roles.active, true),
					sql`lower(${roles.code}) IN ('technician', 'organization_admin')`
				)
			)
			.orderBy(asc(users.name), asc(users.id));

		return rows;
	}

	const rows = await db
		.selectDistinct({
			id: users.id,
			name: users.name
		})
		.from(users)
		.innerJoin(memberships, eq(memberships.userId, users.id))
		.innerJoin(
			roleAssignments,
			and(
				eq(roleAssignments.membershipId, memberships.id),
				eq(roleAssignments.organizationId, organizationId)
			)
		)
		.innerJoin(
			roles,
			and(eq(roles.id, roleAssignments.roleId), eq(roles.organizationId, organizationId))
		)
		.where(
			and(
				eq(memberships.organizationId, organizationId),
				eq(memberships.active, true),
				eq(users.active, true),
				eq(roles.active, true),
				sql`lower(${roles.code}) IN ('technician', 'organization_admin')`
			)
		)
		.orderBy(asc(users.name), asc(users.id));

	return rows;
}

export interface AssignIncidentContext {
	readonly organizationId: string;
	readonly actorUserId: string;
}

export interface AssignIncidentInput {
	readonly teamId?: string | null;
	readonly assignedToUserId?: string | null;
	readonly reason?: string;
}

export interface AssignIncidentResult {
	readonly incident: IncidentRecord;
	readonly history?: IncidentHistoryRecord;
}

/**
 * Assigns or reassigns an incident to a designated team and/or technician within the tenant.
 * Operates in a single atomic transaction:
 * - Validates operational organization and actor permissions.
 * - If teamId is specified, validates team is active and belongs to the organization.
 * - If assignedToUserId is specified, validates target assignee is an active technician/organization_admin.
 * - If both teamId and assignedToUserId are present, validates active team membership.
 * - If changing team without specifying a technician, auto-clears assignee if incompatible with new team.
 * - If target team and assignee are unchanged, returns current incident as a no-op (no history, no updatedAt change).
 * - If already assigned to another team or technician, requires non-empty reason and records 'reassigned' audit event.
 * - If completely unassigned (no team, no technician), reason is optional and records 'assigned' audit event.
 */
export async function assignIncidentRecord(
	dbOrTx: IncidentDatabase,
	context: AssignIncidentContext,
	incidentId: string,
	input: AssignIncidentInput
): Promise<AssignIncidentResult> {
	// 1. Context and ID validation
	if (!isValidUuid(context?.organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}
	if (!isValidUuid(context?.actorUserId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'actorUserId must be a valid UUID');
	}
	if (!isValidUuid(incidentId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'incidentId must be a valid UUID');
	}
	if (input?.teamId !== undefined && input.teamId !== null && !isValidUuid(input.teamId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'teamId must be a valid UUID');
	}
	if (
		input?.assignedToUserId !== undefined &&
		input.assignedToUserId !== null &&
		!isValidUuid(input.assignedToUserId)
	) {
		throw new IncidentServiceError('INVALID_INPUT', 'assignedToUserId must be a valid UUID');
	}
	if (input?.teamId === undefined && input?.assignedToUserId === undefined) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			'At least teamId or assignedToUserId must be provided'
		);
	}

	const execute = async (tx: IncidentDatabase): Promise<AssignIncidentResult> => {
		// A. Validate Organization existence & operational status
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
				`Organization is '${org.status}', operations require 'active'`
			);
		}

		// B. Validate Actor Membership and User Activity
		const [actorRecord] = await tx
			.select({
				membershipActive: memberships.active,
				userActive: users.active
			})
			.from(memberships)
			.innerJoin(users, eq(users.id, memberships.userId))
			.where(
				and(
					eq(memberships.organizationId, context.organizationId),
					eq(memberships.userId, context.actorUserId)
				)
			)
			.limit(1);

		if (!actorRecord) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_NOT_FOUND',
				'Actor user is not a member of this organization'
			);
		}

		if (!actorRecord.membershipActive) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_INACTIVE',
				'Actor user membership is inactive'
			);
		}

		if (!actorRecord.userActive) {
			throw new IncidentServiceError('CREATOR_USER_INACTIVE', 'Actor user account is inactive');
		}

		// C. Query existing incident strictly within tenant
		const [currentIncident] = await tx
			.select()
			.from(incidents)
			.where(
				and(eq(incidents.id, incidentId), eq(incidents.organizationId, context.organizationId))
			)
			.limit(1);

		if (!currentIncident) {
			throw new IncidentServiceError('INCIDENT_NOT_FOUND', 'Incident not found');
		}

		// D. Determine target teamId and validate team if not null
		const finalTeamId = input.teamId !== undefined ? input.teamId : currentIncident.teamId;

		if (finalTeamId !== null) {
			const [targetTeam] = await tx
				.select({ id: teams.id, active: teams.active })
				.from(teams)
				.where(and(eq(teams.id, finalTeamId), eq(teams.organizationId, context.organizationId)))
				.limit(1);

			if (!targetTeam) {
				throw new IncidentServiceError('INVALID_INPUT', 'Team not found in this organization');
			}

			if (!targetTeam.active) {
				throw new IncidentServiceError('INVALID_INPUT', 'Team is inactive');
			}
		}

		// E. Determine candidate assignee
		const isExplicitAssignee = input.assignedToUserId !== undefined;
		const candidateAssigneeId = isExplicitAssignee
			? input.assignedToUserId
			: currentIncident.assignedToUserId;

		if (candidateAssigneeId !== null) {
			const [assigneeRecord] = await tx
				.select({
					id: users.id,
					name: users.name
				})
				.from(users)
				.innerJoin(memberships, eq(memberships.userId, users.id))
				.innerJoin(
					roleAssignments,
					and(
						eq(roleAssignments.membershipId, memberships.id),
						eq(roleAssignments.organizationId, context.organizationId)
					)
				)
				.innerJoin(
					roles,
					and(
						eq(roles.id, roleAssignments.roleId),
						eq(roles.organizationId, context.organizationId)
					)
				)
				.where(
					and(
						eq(users.id, candidateAssigneeId),
						eq(memberships.organizationId, context.organizationId),
						eq(memberships.active, true),
						eq(users.active, true),
						eq(roles.active, true),
						sql`lower(${roles.code}) IN ('technician', 'organization_admin')`
					)
				)
				.limit(1);

			if (!assigneeRecord) {
				throw new IncidentServiceError(
					'ASSIGNEE_NOT_FOUND',
					'Assignee user not found or not eligible in this organization'
				);
			}
		}

		// F. Check team membership for candidate assignee if team is designated
		let isMemberOfFinalTeam = false;
		if (finalTeamId !== null && candidateAssigneeId !== null) {
			const [membershipRow] = await tx
				.select({ id: teamMemberships.id })
				.from(teamMemberships)
				.innerJoin(memberships, eq(memberships.id, teamMemberships.membershipId))
				.where(
					and(
						eq(teamMemberships.organizationId, context.organizationId),
						eq(teamMemberships.teamId, finalTeamId),
						eq(teamMemberships.active, true),
						eq(memberships.organizationId, context.organizationId),
						eq(memberships.userId, candidateAssigneeId),
						eq(memberships.active, true)
					)
				)
				.limit(1);

			isMemberOfFinalTeam = !!membershipRow;
		}

		// G. Determine finalAssigneeId based on explicit vs implicit and team compatibility
		let finalAssigneeId: string | null;
		if (isExplicitAssignee) {
			if (input.assignedToUserId === null) {
				finalAssigneeId = null;
			} else {
				if (finalTeamId !== null && !isMemberOfFinalTeam) {
					throw new IncidentServiceError(
						'INVALID_INPUT',
						'Assignee is not an active member of the designated team'
					);
				}
				finalAssigneeId = input.assignedToUserId;
			}
		} else {
			if (currentIncident.assignedToUserId === null) {
				finalAssigneeId = null;
			} else {
				if (finalTeamId === null) {
					finalAssigneeId = currentIncident.assignedToUserId;
				} else if (isMemberOfFinalTeam) {
					finalAssigneeId = currentIncident.assignedToUserId;
				} else {
					// Auto-clear technician if incompatible with the new team!
					finalAssigneeId = null;
				}
			}
		}

		// H. No-op handling: if both teamId and assignedToUserId are unchanged, return current state
		if (
			finalTeamId === currentIncident.teamId &&
			finalAssigneeId === currentIncident.assignedToUserId
		) {
			return { incident: currentIncident };
		}

		// I. Validate reason: required on any reassignment; optional on first assignment from completely unassigned
		const wasCompletelyUnassigned =
			currentIncident.teamId === null && currentIncident.assignedToUserId === null;

		let cleanReason: string | null = null;
		if (!wasCompletelyUnassigned) {
			if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
				throw new IncidentServiceError(
					'INVALID_INPUT',
					'Reason is required when reassigning an incident'
				);
			}
			cleanReason = input.reason.trim();
		} else if (typeof input.reason === 'string' && input.reason.trim().length > 0) {
			cleanReason = input.reason.trim();
		}

		// J. Update incident record
		const [updatedIncident] = await tx
			.update(incidents)
			.set({
				teamId: finalTeamId,
				assignedToUserId: finalAssigneeId,
				updatedAt: new Date()
			})
			.where(
				and(eq(incidents.id, incidentId), eq(incidents.organizationId, context.organizationId))
			)
			.returning();

		// K. Insert audit history event
		const eventType = wasCompletelyUnassigned ? 'assigned' : 'reassigned';
		const [historyRecord] = await tx
			.insert(incidentHistory)
			.values({
				incidentId,
				organizationId: context.organizationId,
				eventType,
				actorType: 'user',
				actorUserId: context.actorUserId,
				reason: cleanReason,
				comment: null,
				payload: {
					previousTeamId: currentIncident.teamId,
					newTeamId: finalTeamId,
					previousAssigneeUserId: currentIncident.assignedToUserId,
					newAssigneeUserId: finalAssigneeId
				}
			})
			.returning();

		return { incident: updatedIncident, history: historyRecord };
	};

	if ('transaction' in dbOrTx && typeof dbOrTx.transaction === 'function') {
		return await dbOrTx.transaction(async (tx) => execute(tx));
	}
	return await execute(dbOrTx);
}

export interface UpdateIncidentSupportLevelContext {
	readonly organizationId: string;
	readonly actorUserId: string;
}

export interface UpdateIncidentSupportLevelInput {
	supportLevel: SupportLevel;
	reason?: string;
}

export interface UpdateIncidentSupportLevelResult {
	incident: IncidentRecord;
	history?: IncidentHistoryRecord;
}

/**
 * Updates an incident's support level (N1, N2, N3).
 * Operates in a single atomic transaction:
 * - Validates operational organization and actor permissions.
 * - Validates incident exists in the organization.
 * - If target supportLevel matches current supportLevel:
 *   * No DB update, no updatedAt alteration, no history record created, no reason required.
 *   * Returns current incident (clean no-op).
 * - If changing supportLevel:
 *   * Validates target supportLevel is in ('N1', 'N2', 'N3').
 *   * Requires non-empty string reason.
 *   * Updates incident support_level and updatedAt.
 *   * Inserts append-only incident_history event with eventType: 'support_level_changed',
 *     reason, and payload { previousSupportLevel, newSupportLevel }.
 */
export async function updateIncidentSupportLevel(
	dbOrTx: IncidentDatabase,
	context: UpdateIncidentSupportLevelContext,
	incidentId: string,
	input: UpdateIncidentSupportLevelInput
): Promise<UpdateIncidentSupportLevelResult> {
	// 1. Context and ID validation
	if (!isValidUuid(context?.organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}
	if (!isValidUuid(context?.actorUserId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'actorUserId must be a valid UUID');
	}
	if (!isValidUuid(incidentId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'incidentId must be a valid UUID');
	}

	if (!input || !VALID_SUPPORT_LEVELS_SET.has(input.supportLevel)) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`invalid supportLevel '${String(input?.supportLevel)}'. Must be one of: N1, N2, N3`
		);
	}

	const execute = async (tx: IncidentDatabase): Promise<UpdateIncidentSupportLevelResult> => {
		// A. Validate Organization existence & operational status
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
				`Organization is '${org.status}', operations require 'active'`
			);
		}

		// B. Validate Actor Membership and User Activity
		const [actorRecord] = await tx
			.select({
				membershipActive: memberships.active,
				userActive: users.active
			})
			.from(memberships)
			.innerJoin(users, eq(users.id, memberships.userId))
			.where(
				and(
					eq(memberships.organizationId, context.organizationId),
					eq(memberships.userId, context.actorUserId)
				)
			)
			.limit(1);

		if (!actorRecord) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_NOT_FOUND',
				'Actor user is not a member of this organization'
			);
		}

		if (!actorRecord.membershipActive) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_INACTIVE',
				'Actor user membership is inactive'
			);
		}

		if (!actorRecord.userActive) {
			throw new IncidentServiceError('CREATOR_USER_INACTIVE', 'Actor user account is inactive');
		}

		// C. Query existing incident strictly within tenant
		const [currentIncident] = await tx
			.select()
			.from(incidents)
			.where(
				and(eq(incidents.id, incidentId), eq(incidents.organizationId, context.organizationId))
			)
			.limit(1);

		if (!currentIncident) {
			throw new IncidentServiceError('INCIDENT_NOT_FOUND', 'Incident not found');
		}

		// D. No-op handling: if supportLevel is unchanged, return current incident without modifying DB
		if (input.supportLevel === currentIncident.supportLevel) {
			return { incident: currentIncident };
		}

		// E. Validate reason: required and non-empty string when changing support level
		if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
			throw new IncidentServiceError(
				'INVALID_INPUT',
				'Reason is required when changing support level'
			);
		}
		const cleanReason = input.reason.trim();

		// F. Update incident support_level
		const [updatedIncident] = await tx
			.update(incidents)
			.set({
				supportLevel: input.supportLevel,
				updatedAt: new Date()
			})
			.where(
				and(eq(incidents.id, incidentId), eq(incidents.organizationId, context.organizationId))
			)
			.returning();

		// G. Insert audit history event
		const [historyRecord] = await tx
			.insert(incidentHistory)
			.values({
				incidentId,
				organizationId: context.organizationId,
				eventType: 'support_level_changed',
				actorType: 'user',
				actorUserId: context.actorUserId,
				reason: cleanReason,
				comment: null,
				payload: {
					previousSupportLevel: currentIncident.supportLevel,
					newSupportLevel: input.supportLevel
				}
			})
			.returning();

		return { incident: updatedIncident, history: historyRecord };
	};

	if ('transaction' in dbOrTx && typeof dbOrTx.transaction === 'function') {
		return await dbOrTx.transaction(async (tx) => execute(tx));
	}
	return await execute(dbOrTx);
}

export { updateIncidentSupportLevel as updateIncidentSupportLevelRecord };

export const INCIDENT_REASON_MAX_LENGTH = 1000;

export interface ChangeIncidentSiteContext {
	readonly organizationId: string;
	readonly actorUserId: string;
}

export interface ChangeIncidentSiteInput {
	/** Target site UUID, or null to remove the site. */
	siteId: string | null;
	reason?: string;
}

export interface ChangeIncidentSiteResult {
	incident: IncidentRecord;
	history?: IncidentHistoryRecord;
}

/**
 * Changes (or removes) the site of an incident in a single transaction.
 * - The incident is locked FOR UPDATE within the tenant; the target site is validated with
 *   lockActiveSite (scoped by id + organization, FOR SHARE against concurrent deactivation).
 * - No-op when the target equals the current site (including null -> null): no update, no history.
 * - Reason: optional when setting a site on an incident without one; required when replacing
 *   or removing an existing site (same rule as assignment vs. reassignment).
 * - Records 'site_changed' with payload { fromSiteId, toSiteId } only; never names or tenant data.
 * - Does not alter status, priority, team, assignee, support level or SLA.
 */
export async function changeIncidentSite(
	dbOrTx: IncidentDatabase,
	context: ChangeIncidentSiteContext,
	incidentId: string,
	input: ChangeIncidentSiteInput
): Promise<ChangeIncidentSiteResult> {
	// 1. Context and input validation
	if (!isValidUuid(context?.organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}
	if (!isValidUuid(context?.actorUserId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'actorUserId must be a valid UUID');
	}
	if (!isValidUuid(incidentId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'incidentId must be a valid UUID');
	}
	if (!input || (input.siteId !== null && !isValidUuid(input.siteId))) {
		throw new IncidentServiceError('INVALID_INPUT', 'siteId must be a valid UUID or null');
	}
	if (input.reason !== undefined) {
		if (typeof input.reason !== 'string') {
			throw new IncidentServiceError('INVALID_INPUT', 'reason must be a string');
		}
		if (input.reason.trim().length > INCIDENT_REASON_MAX_LENGTH) {
			throw new IncidentServiceError(
				'INVALID_INPUT',
				`reason must not exceed ${INCIDENT_REASON_MAX_LENGTH} characters`
			);
		}
		if (input.reason.includes('\u0000')) {
			throw new IncidentServiceError('INVALID_INPUT', 'reason contains invalid characters');
		}
	}
	const targetSiteId = input.siteId;

	const execute = async (tx: IncidentDatabase): Promise<ChangeIncidentSiteResult> => {
		// A. Validate Organization existence & operational status
		const [org] = await tx
			.select({ status: organizations.status })
			.from(organizations)
			.where(eq(organizations.id, context.organizationId))
			.limit(1);
		if (!org) {
			throw new IncidentServiceError('ORGANIZATION_NOT_FOUND', 'Organization does not exist');
		}
		if (org.status !== 'active') {
			throw new IncidentServiceError(
				'ORGANIZATION_NOT_OPERATIONAL',
				`Organization is '${org.status}', operations require 'active'`
			);
		}

		// B. Validate Actor Membership and User Activity
		const [actorRecord] = await tx
			.select({ membershipActive: memberships.active, userActive: users.active })
			.from(memberships)
			.innerJoin(users, eq(users.id, memberships.userId))
			.where(
				and(
					eq(memberships.organizationId, context.organizationId),
					eq(memberships.userId, context.actorUserId)
				)
			)
			.limit(1);
		if (!actorRecord) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_NOT_FOUND',
				'Actor user is not a member of this organization'
			);
		}
		if (!actorRecord.membershipActive) {
			throw new IncidentServiceError(
				'CREATOR_MEMBERSHIP_INACTIVE',
				'Actor user membership is inactive'
			);
		}
		if (!actorRecord.userActive) {
			throw new IncidentServiceError('CREATOR_USER_INACTIVE', 'Actor user account is inactive');
		}

		// C. Lock the incident strictly within the tenant
		const [currentIncident] = await tx
			.select()
			.from(incidents)
			.where(
				and(eq(incidents.id, incidentId), eq(incidents.organizationId, context.organizationId))
			)
			.limit(1)
			.for('update');
		if (!currentIncident) {
			throw new IncidentServiceError('INCIDENT_NOT_FOUND', 'Incident not found');
		}

		// D. No-op: same site (or null -> null)
		const fromSiteId = currentIncident.siteId ?? null;
		if (fromSiteId === targetSiteId) {
			return { incident: currentIncident };
		}

		// E. Reason rule
		const cleanReason = input.reason?.trim() || null;
		if (fromSiteId !== null && cleanReason === null) {
			throw new IncidentServiceError(
				'INVALID_INPUT',
				'Reason is required when changing or removing the site of an incident'
			);
		}

		// F. Validate and lock the target site
		if (targetSiteId !== null) {
			await lockActiveSite(tx, context.organizationId, targetSiteId);
		}

		// G. Update incident
		const [updatedIncident] = await tx
			.update(incidents)
			.set({ siteId: targetSiteId, updatedAt: new Date() })
			.where(
				and(eq(incidents.id, incidentId), eq(incidents.organizationId, context.organizationId))
			)
			.returning();

		// H. Append-only audit event
		const [historyRecord] = await tx
			.insert(incidentHistory)
			.values({
				incidentId,
				organizationId: context.organizationId,
				eventType: 'site_changed',
				actorType: 'user',
				actorUserId: context.actorUserId,
				reason: cleanReason,
				comment: null,
				payload: { fromSiteId, toSiteId: targetSiteId }
			})
			.returning();

		return { incident: updatedIncident, history: historyRecord };
	};

	if ('transaction' in dbOrTx && typeof dbOrTx.transaction === 'function') {
		return await dbOrTx.transaction(async (tx) => execute(tx));
	}
	return await execute(dbOrTx);
}
