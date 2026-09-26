import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, lte, or, sql, type SQL } from 'drizzle-orm';
import {
	invitations,
	memberships,
	organizations,
	rolePermissions,
	roles,
	userEmails,
	users
} from '../db/schema';
import type { PermissionId } from '../auth/permissions';
import type { InvitationEmailSender } from '../email/invitation-email';
import { IncidentServiceError, type IncidentDatabase } from './incidents';
import { assertDelegable, assertOperationalOrganization } from './roles';

/**
 * Administrative invitations (5.4S-C). Public verification/acceptance, user creation, membership
 * creation and role assignment on acceptance belong to 5.4S-D and are NOT implemented here: this
 * service never writes users, memberships, role_assignments or auth tables.
 *
 * Token handling: a 256-bit random token is generated per issue (create / resend), only its
 * SHA-256 is persisted, and the raw token is handed to the email sender after commit. It is never
 * persisted, logged or returned in any DTO.
 *
 * Expiration: status 'pending' with expires_at <= now is EXPIRED. Reads derive it (no side
 * effects in GET); mutations persist it lazily (create retires an expired pending row for the same
 * email; resend reactivates it with a fresh token).
 */

export const INVITATION_TTL_HOURS = 48;
export const INVITATION_EMAIL_MAX_LENGTH = 255;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
export const INVITATION_STATUSES: readonly InvitationStatus[] = [
	'pending',
	'accepted',
	'revoked',
	'expired'
];

/** Safe administrative DTO: never token_hash, raw token, organizationId or auth data. */
export interface InvitationRecord {
	id: string;
	email: string;
	/** Effective status: a pending invitation past expires_at is reported as 'expired'. */
	status: InvitationStatus;
	expiresAt: Date;
	acceptedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	role: { id: string; code: string; name: string; active: boolean };
	invitedBy: { id: string; name: string };
}

/** Internal result of create / resend: the DTO plus what the email sender needs. */
export interface IssuedInvitation {
	invitation: InvitationRecord;
	delivery: {
		email: string;
		organizationName: string;
		roleName: string;
		token: string;
		expiresAt: Date;
	};
}

export interface InvitationActorContext {
	readonly organizationId: string;
	/** Principal user id (identity comes from the session, never from the body). */
	readonly actorUserId: string;
	/** Actor's effective permissions in the organization, for monotonic delegation. */
	readonly actorPermissions: readonly PermissionId[];
}

export interface ListInvitationsFilters {
	status?: InvitationStatus;
	email?: string;
}

// =============================================================================
// Token helpers
// =============================================================================

/** 32 random bytes (256 bits) from the OS CSPRNG, base64url (43 URL-safe characters). */
export function generateInvitationToken(): string {
	return randomBytes(32).toString('base64url');
}

/** SHA-256 of the raw token, lowercase hex (64 characters: invitations.token_hash). */
export function hashInvitationToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

// =============================================================================
// Validation helpers
// =============================================================================

function invalid(message: string): IncidentServiceError {
	return new IncidentServiceError('INVALID_INPUT', message);
}

function assertUuid(value: unknown, name: string): asserts value is string {
	if (typeof value !== 'string' || !uuidRegex.test(value)) throw invalid(`${name} must be a UUID`);
}

/**
 * trim + lower-case, then a reasonable (non-RFC-exhaustive) shape check, same policy as identity
 * provisioning. The database CHECK rejects anything not normalized this way.
 */
export function normalizeInvitationEmail(email: unknown): string {
	if (typeof email !== 'string') throw invalid('email must be a string');
	const normalized = email.trim().toLowerCase();
	if (
		normalized.length === 0 ||
		normalized.length > INVITATION_EMAIL_MAX_LENGTH ||
		!EMAIL_PATTERN.test(normalized)
	)
		throw invalid('email must be a valid address');
	return normalized;
}

function newExpiry(now: Date): Date {
	return new Date(now.getTime() + INVITATION_TTL_HOURS * 3600 * 1000);
}

function isExpiredPending(row: { status: string; expiresAt: Date }, now: Date): boolean {
	return row.status === 'pending' && row.expiresAt.getTime() <= now.getTime();
}

function isUniqueViolation(error: unknown): boolean {
	return [error, (error as { cause?: unknown })?.cause].some(
		(candidate) => (candidate as { code?: unknown } | null)?.code === '23505'
	);
}

async function inTransaction<T>(
	db: IncidentDatabase,
	execute: (tx: IncidentDatabase) => Promise<T>
): Promise<T> {
	if ('transaction' in db && typeof db.transaction === 'function') {
		return await db.transaction(async (tx) => execute(tx));
	}
	return await execute(db);
}

// =============================================================================
// Read model
// =============================================================================

const invitationColumns = {
	id: invitations.id,
	email: invitations.email,
	status: invitations.status,
	expiresAt: invitations.expiresAt,
	acceptedAt: invitations.acceptedAt,
	createdAt: invitations.createdAt,
	updatedAt: invitations.updatedAt,
	roleId: roles.id,
	roleCode: roles.code,
	roleName: roles.name,
	roleActive: roles.active,
	inviterId: users.id,
	inviterName: users.name
};

type InvitationRow = {
	id: string;
	email: string;
	status: string;
	expiresAt: Date;
	acceptedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
	roleId: string;
	roleCode: string;
	roleName: string;
	roleActive: boolean;
	inviterId: string;
	inviterName: string;
};

function toRecord(row: InvitationRow, now: Date): InvitationRecord {
	return {
		id: row.id,
		email: row.email,
		status: isExpiredPending(row, now) ? 'expired' : (row.status as InvitationStatus),
		expiresAt: row.expiresAt,
		acceptedAt: row.acceptedAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		role: { id: row.roleId, code: row.roleCode, name: row.roleName, active: row.roleActive },
		invitedBy: { id: row.inviterId, name: row.inviterName }
	};
}

function selectInvitations(db: IncidentDatabase, where: SQL | undefined) {
	return db
		.select(invitationColumns)
		.from(invitations)
		.innerJoin(
			roles,
			and(eq(roles.id, invitations.roleId), eq(roles.organizationId, invitations.organizationId))
		)
		.innerJoin(users, eq(users.id, invitations.invitedByUserId))
		.where(where);
}

/** Effective-status SQL filter (pending/expired derived from expires_at). */
function statusCondition(status: InvitationStatus, now: Date): SQL {
	if (status === 'pending')
		return and(eq(invitations.status, 'pending'), gt(invitations.expiresAt, now))!;
	if (status === 'expired')
		return or(
			eq(invitations.status, 'expired'),
			and(eq(invitations.status, 'pending'), lte(invitations.expiresAt, now))
		)!;
	return eq(invitations.status, status);
}

/**
 * Invitations of one organization, newest first (created_at DESC, id DESC). Optional strict
 * filters: effective status and exact (normalized) email. Caller authorizes invitations:view.
 */
export async function listInvitations(
	db: IncidentDatabase,
	organizationId: string,
	filters: ListInvitationsFilters = {}
): Promise<InvitationRecord[]> {
	assertUuid(organizationId, 'organizationId');
	const now = new Date();
	const conditions: SQL[] = [eq(invitations.organizationId, organizationId)];
	if (filters.status !== undefined) {
		if (!INVITATION_STATUSES.includes(filters.status)) throw invalid('invalid status filter');
		conditions.push(statusCondition(filters.status, now));
	}
	if (filters.email !== undefined)
		conditions.push(eq(invitations.email, normalizeInvitationEmail(filters.email)));
	const rows = await selectInvitations(db, and(...conditions)).orderBy(
		desc(invitations.createdAt),
		desc(invitations.id)
	);
	return rows.map((row) => toRecord(row, now));
}

/** One invitation of the organization; another tenant's id behaves exactly like a missing one. */
export async function getInvitation(
	db: IncidentDatabase,
	organizationId: string,
	invitationId: string
): Promise<InvitationRecord> {
	assertUuid(organizationId, 'organizationId');
	assertUuid(invitationId, 'invitationId');
	const [row] = await selectInvitations(
		db,
		and(eq(invitations.id, invitationId), eq(invitations.organizationId, organizationId))
	).limit(1);
	if (!row) throw new IncidentServiceError('INVITATION_NOT_FOUND', 'Invitation not found');
	return toRecord(row, new Date());
}

// =============================================================================
// Mutations
// =============================================================================

async function organizationName(tx: IncidentDatabase, organizationId: string): Promise<string> {
	const [org] = await tx
		.select({ name: organizations.name })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	return org.name;
}

/**
 * The invited role must belong to the organization, be active, and be fully delegable by the
 * actor: every permission of the role (system or custom alike; a role with non-canonical
 * permissions is never delegable) must be held by the actor. Never decided by role code.
 */
async function assertInvitableRole(
	tx: IncidentDatabase,
	organizationId: string,
	roleId: string,
	actorPermissions: readonly PermissionId[]
) {
	const [role] = await tx
		.select({ id: roles.id, name: roles.name, active: roles.active })
		.from(roles)
		.where(and(eq(roles.id, roleId), eq(roles.organizationId, organizationId)))
		.limit(1)
		.for('share');
	if (!role) throw new IncidentServiceError('ROLE_NOT_FOUND', 'Role not found');
	if (!role.active) throw new IncidentServiceError('ROLE_INACTIVE', 'Role is not active');
	const permissions = (
		await tx
			.select({ permissionId: rolePermissions.permissionId })
			.from(rolePermissions)
			.where(eq(rolePermissions.roleId, roleId))
			.for('share')
	).map((row) => row.permissionId);
	assertDelegable(actorPermissions, permissions);
	return role;
}

/**
 * Membership state of the email's identity in THIS organization only (never other tenants):
 * active membership -> ALREADY_MEMBER; inactive membership -> MEMBERSHIP_INACTIVE (reactivation
 * is an explicit lifecycle action, not an invitation side effect).
 */
async function assertNotMember(tx: IncidentDatabase, organizationId: string, email: string) {
	const [membership] = await tx
		.select({ active: memberships.active })
		.from(userEmails)
		.innerJoin(
			memberships,
			and(eq(memberships.userId, userEmails.userId), eq(memberships.organizationId, organizationId))
		)
		.where(sql`lower(${userEmails.email}) = ${email}`)
		.limit(1);
	if (!membership) return;
	if (membership.active)
		throw new IncidentServiceError('ALREADY_MEMBER', 'Already a member of the organization');
	throw new IncidentServiceError('MEMBERSHIP_INACTIVE', 'Membership is not active');
}

/**
 * Sends the invitation email for an issued invitation (after the database commit). A failure is
 * reported as EMAIL_DELIVERY_FAILED; the invitation stays pending and can be resent.
 */
export async function deliverInvitation(
	sender: InvitationEmailSender,
	issued: IssuedInvitation
): Promise<void> {
	try {
		await sender.sendInvitation({ ...issued.delivery });
	} catch {
		throw new IncidentServiceError(
			'EMAIL_DELIVERY_FAILED',
			'The invitation was saved but the email could not be delivered'
		);
	}
}

/**
 * Creates a pending invitation in one transaction (the email is sent afterwards by
 * deliverInvitation, never inside the transaction). Caller authorizes invitations:create and
 * roles:assign; this service enforces tenant, role and delegation rules:
 * - organization active (row locked FOR UPDATE: serializes invitation issuing per tenant);
 * - role of this organization, active, fully delegable (ROLE_NOT_FOUND / ROLE_INACTIVE /
 *   PERMISSION_NOT_DELEGABLE);
 * - email not already a member here (ALREADY_MEMBER / MEMBERSHIP_INACTIVE);
 * - no live pending invitation for the email (INVITATION_ALREADY_PENDING; resend is a separate
 *   operation). An expired pending row is retired (status expired) first.
 */
export async function createInvitation(
	db: IncidentDatabase,
	context: InvitationActorContext,
	input: { email: unknown; roleId: unknown }
): Promise<IssuedInvitation> {
	assertUuid(context?.organizationId, 'organizationId');
	assertUuid(context.actorUserId, 'actorUserId');
	if (!input || typeof input !== 'object') throw invalid('invalid invitation input');
	const email = normalizeInvitationEmail(input.email);
	assertUuid(input.roleId, 'roleId');
	const roleId = input.roleId;
	const token = generateInvitationToken();
	try {
		return await inTransaction(db, async (tx) => {
			await assertOperationalOrganization(tx, context.organizationId, 'update');
			const role = await assertInvitableRole(
				tx,
				context.organizationId,
				roleId,
				context.actorPermissions
			);
			await assertNotMember(tx, context.organizationId, email);
			const now = new Date();
			const [pending] = await tx
				.select({
					id: invitations.id,
					status: invitations.status,
					expiresAt: invitations.expiresAt
				})
				.from(invitations)
				.where(
					and(
						eq(invitations.organizationId, context.organizationId),
						eq(invitations.email, email),
						eq(invitations.status, 'pending')
					)
				)
				.limit(1)
				.for('update');
			if (pending && !isExpiredPending(pending, now))
				throw new IncidentServiceError(
					'INVITATION_ALREADY_PENDING',
					'A pending invitation already exists for this email'
				);
			if (pending)
				await tx
					.update(invitations)
					.set({ status: 'expired', updatedAt: now })
					.where(eq(invitations.id, pending.id));
			const expiresAt = newExpiry(now);
			const [created] = await tx
				.insert(invitations)
				.values({
					organizationId: context.organizationId,
					email,
					roleId,
					tokenHash: hashInvitationToken(token),
					status: 'pending',
					invitedByUserId: context.actorUserId,
					expiresAt,
					createdAt: now,
					updatedAt: now
				})
				.returning({ id: invitations.id });
			return {
				invitation: await getInvitation(tx, context.organizationId, created.id),
				delivery: {
					email,
					organizationName: await organizationName(tx, context.organizationId),
					roleName: role.name,
					token,
					expiresAt
				}
			};
		});
	} catch (error) {
		// Concurrent create for the same email: the partial unique index is the final guard.
		if (!(error instanceof IncidentServiceError) && isUniqueViolation(error))
			throw new IncidentServiceError(
				'INVITATION_ALREADY_PENDING',
				'A pending invitation already exists for this email'
			);
		throw error;
	}
}

/**
 * Revokes a pending invitation (status revoked, updated_at now; the row is kept).
 * - pending (not expired): revoked;
 * - already revoked: idempotent no-op;
 * - accepted or expired: INVITATION_NOT_REVOCABLE (an expired token is already unusable).
 * Caller authorizes invitations:revoke.
 */
export async function revokeInvitation(
	db: IncidentDatabase,
	organizationId: string,
	invitationId: string
): Promise<void> {
	assertUuid(organizationId, 'organizationId');
	assertUuid(invitationId, 'invitationId');
	await inTransaction(db, async (tx) => {
		await assertOperationalOrganization(tx, organizationId, 'update');
		const [row] = await tx
			.select({ id: invitations.id, status: invitations.status, expiresAt: invitations.expiresAt })
			.from(invitations)
			.where(and(eq(invitations.id, invitationId), eq(invitations.organizationId, organizationId)))
			.limit(1)
			.for('update');
		if (!row) throw new IncidentServiceError('INVITATION_NOT_FOUND', 'Invitation not found');
		if (row.status === 'revoked') return;
		if (row.status !== 'pending' || isExpiredPending(row, new Date()))
			throw new IncidentServiceError('INVITATION_NOT_REVOCABLE', 'Invitation cannot be revoked');
		await tx
			.update(invitations)
			.set({ status: 'revoked', updatedAt: new Date() })
			.where(and(eq(invitations.id, invitationId), eq(invitations.organizationId, organizationId)));
	});
}

/**
 * Re-issues an invitation on the same row: new token (the previous hash is overwritten, so the
 * old token can never match again), new 48 h expiry, status pending, updated_at now.
 * - pending or expired: re-issued (expired is reactivated);
 * - revoked or accepted: INVITATION_NOT_RESENDABLE (create a new invitation instead).
 * The role and membership rules are re-checked against the current actor and state (delegation,
 * ROLE_INACTIVE, ALREADY_MEMBER). Caller authorizes invitations:create and roles:assign.
 */
export async function resendInvitation(
	db: IncidentDatabase,
	context: InvitationActorContext,
	invitationId: string
): Promise<IssuedInvitation> {
	assertUuid(context?.organizationId, 'organizationId');
	assertUuid(context.actorUserId, 'actorUserId');
	assertUuid(invitationId, 'invitationId');
	const token = generateInvitationToken();
	try {
		return await inTransaction(db, async (tx) => {
			await assertOperationalOrganization(tx, context.organizationId, 'update');
			const [row] = await tx
				.select({
					id: invitations.id,
					email: invitations.email,
					roleId: invitations.roleId,
					status: invitations.status
				})
				.from(invitations)
				.where(
					and(
						eq(invitations.id, invitationId),
						eq(invitations.organizationId, context.organizationId)
					)
				)
				.limit(1)
				.for('update');
			if (!row) throw new IncidentServiceError('INVITATION_NOT_FOUND', 'Invitation not found');
			if (row.status !== 'pending' && row.status !== 'expired')
				throw new IncidentServiceError('INVITATION_NOT_RESENDABLE', 'Invitation cannot be resent');
			const role = await assertInvitableRole(
				tx,
				context.organizationId,
				row.roleId,
				context.actorPermissions
			);
			await assertNotMember(tx, context.organizationId, row.email);
			const now = new Date();
			const expiresAt = newExpiry(now);
			await tx
				.update(invitations)
				.set({
					tokenHash: hashInvitationToken(token),
					status: 'pending',
					expiresAt,
					updatedAt: now
				})
				.where(
					and(
						eq(invitations.id, invitationId),
						eq(invitations.organizationId, context.organizationId)
					)
				);
			return {
				invitation: await getInvitation(tx, context.organizationId, invitationId),
				delivery: {
					email: row.email,
					organizationName: await organizationName(tx, context.organizationId),
					roleName: role.name,
					token,
					expiresAt
				}
			};
		});
	} catch (error) {
		// Reactivating an expired invitation while a newer pending one exists for the same email.
		if (!(error instanceof IncidentServiceError) && isUniqueViolation(error))
			throw new IncidentServiceError(
				'INVITATION_ALREADY_PENDING',
				'A pending invitation already exists for this email'
			);
		throw error;
	}
}
