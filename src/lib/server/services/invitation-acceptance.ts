import { and, eq, sql } from 'drizzle-orm';
import { hashPassword } from 'better-auth/crypto';
import {
	authAccounts,
	authUsers,
	invitations,
	memberships,
	organizations,
	roleAssignments,
	rolePermissions,
	roles,
	userEmails,
	users
} from '../db/schema';
import { IncidentServiceError, type IncidentDatabase } from './incidents';
import { hashInvitationToken } from './invitations';

/**
 * Public invitation verification and acceptance (5.4S-D).
 *
 * Authority comes only from a valid invitation token (256-bit, looked up by its SHA-256) plus, for
 * an existing identity, a session of that exact identity. No admin permission is involved.
 *
 * Identity anchor: invitation.email. The invitee never chooses email, user, organization or role.
 * - The email already belongs to a user (user_emails, case-insensitive, globally unique):
 *   the caller must be signed in as that user (AUTHENTICATION_REQUIRED without a session,
 *   INVALID_ACCEPTOR for another user). The identity is reused; its password and verification
 *   state are never touched.
 * - Otherwise a new identity is provisioned (users, user_emails, auth_users, credential
 *   auth_accounts) exactly like identity provisioning: Better Auth's own password hasher, same
 *   transaction. Possessing the token emailed to the address proves control of the mailbox, so the
 *   new email is marked verified. No session is created (the user signs in normally).
 *   A caller signed in as someone else is rejected (INVALID_ACCEPTOR).
 * Revealing "you must sign in" only reaches the token holder, i.e. the owner of the invited
 * mailbox; verification never reveals whether an account exists.
 *
 * Role safety: the invitation stores the role's permission ids delegated at issue time. Accepting
 * requires the role to still be active in the same organization and its current permissions to be
 * a subset of that snapshot: a role widened after issue cannot be granted (the invitation becomes
 * invalid until an admin resends it). The inviter's current status is irrelevant: the invitation
 * is an organization resource.
 */

export const INVITATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Same bounds as identity provisioning (Better Auth default max is 128). */
export const INVITEE_PASSWORD_MIN_LENGTH = 12;
export const INVITEE_PASSWORD_MAX_LENGTH = 128;
export const INVITEE_NAME_MAX_LENGTH = 255;

export interface PublicInvitation {
	organizationName: string;
	roleName: string;
	expiresAt: Date;
	/** First character of the local part, then ***, then the domain. */
	maskedEmail: string;
}

export interface AcceptInvitationInput {
	/** Raw token exactly as received (outer whitespace trimmed). */
	token: string;
	/** Session user, resolved by the caller from server headers (null without a valid session). */
	principalUserId: string | null;
	name?: unknown;
	password?: unknown;
}

export interface AcceptedInvitation {
	organizationName: string;
	/** True when no session was used (a new identity was created): sign in normally next. */
	requiresLogin: boolean;
}

function invalidInvitation(): IncidentServiceError {
	return new IncidentServiceError('INVALID_INVITATION', 'Invalid invitation');
}

function invalidInput(message: string): IncidentServiceError {
	return new IncidentServiceError('INVALID_INPUT', message);
}

/** Outer whitespace only; base64url is case-sensitive and never normalized otherwise. */
export function normalizeInvitationToken(token: unknown): string {
	if (typeof token !== 'string') throw invalidInput('token must be a string');
	return token.trim();
}

export function maskEmail(email: string): string {
	const at = email.lastIndexOf('@');
	return `${email.slice(0, 1)}***${email.slice(at)}`;
}

function isUniqueViolation(error: unknown): boolean {
	return [error, (error as { cause?: unknown })?.cause].some(
		(candidate) => (candidate as { code?: unknown } | null)?.code === '23505'
	);
}

/**
 * Loads a usable invitation by token hash: effective status pending (not expired, not accepted),
 * organization active, role active in the same organization and not widened since issue.
 * Every failure is the same INVALID_INVITATION (unknown, revoked, expired, used, invalidated).
 */
async function loadUsableInvitation(tx: IncidentDatabase, token: string, lock: boolean) {
	if (!INVITATION_TOKEN_PATTERN.test(token)) throw invalidInvitation();
	const query = tx
		.select({
			id: invitations.id,
			organizationId: invitations.organizationId,
			email: invitations.email,
			roleId: invitations.roleId,
			status: invitations.status,
			expiresAt: invitations.expiresAt,
			acceptedAt: invitations.acceptedAt,
			snapshot: invitations.rolePermissionIds
		})
		.from(invitations)
		.where(eq(invitations.tokenHash, hashInvitationToken(token)))
		.limit(1);
	const [invitation] = await (lock ? query.for('update') : query);
	if (
		!invitation ||
		invitation.status !== 'pending' ||
		invitation.acceptedAt !== null ||
		invitation.expiresAt.getTime() <= Date.now()
	)
		throw invalidInvitation();
	const orgQuery = tx
		.select({ name: organizations.name, status: organizations.status })
		.from(organizations)
		.where(eq(organizations.id, invitation.organizationId))
		.limit(1);
	const [org] = await (lock ? orgQuery.for('share') : orgQuery);
	if (!org || org.status !== 'active') throw invalidInvitation();
	const roleQuery = tx
		.select({ name: roles.name, active: roles.active })
		.from(roles)
		.where(
			and(eq(roles.id, invitation.roleId), eq(roles.organizationId, invitation.organizationId))
		)
		.limit(1);
	const [role] = await (lock ? roleQuery.for('share') : roleQuery);
	if (!role || !role.active) throw invalidInvitation();
	const current = await tx
		.select({ permissionId: rolePermissions.permissionId })
		.from(rolePermissions)
		.where(eq(rolePermissions.roleId, invitation.roleId));
	const delegated = new Set(invitation.snapshot);
	if (current.some((row) => !delegated.has(row.permissionId))) throw invalidInvitation();
	return { invitation, organizationName: org.name, roleName: role.name };
}

/** Public, read-only verification. Never reveals ids, the full email or account state. */
export async function verifyInvitationToken(
	db: IncidentDatabase,
	rawToken: unknown
): Promise<PublicInvitation> {
	const token = normalizeInvitationToken(rawToken);
	const { invitation, organizationName, roleName } = await loadUsableInvitation(db, token, false);
	return {
		organizationName,
		roleName,
		expiresAt: invitation.expiresAt,
		maskedEmail: maskEmail(invitation.email)
	};
}

function validateOnboarding(name: unknown, password: unknown): { name: string; password: string } {
	if (typeof name !== 'string' || typeof password !== 'string')
		throw invalidInput('name and password are required');
	const trimmed = name.trim();
	if (
		trimmed.length === 0 ||
		trimmed.length > INVITEE_NAME_MAX_LENGTH ||
		trimmed.includes('\u0000')
	)
		throw invalidInput('invalid name');
	// Never trimmed or truncated: validated exactly as typed.
	if (
		password.length < INVITEE_PASSWORD_MIN_LENGTH ||
		password.length > INVITEE_PASSWORD_MAX_LENGTH ||
		password.includes('\u0000')
	)
		throw invalidInput('invalid password');
	return { name: trimmed, password };
}

/**
 * Accepts an invitation in ONE transaction: invitation locked FOR UPDATE and re-validated, identity
 * resolved or created, membership ensured, the invited role assigned, invitation marked accepted.
 * Any failure rolls everything back. A concurrent acceptance of the same token waits on the row
 * lock and then sees it accepted (INVALID_INVITATION): single use.
 */
export async function acceptInvitation(
	db: IncidentDatabase,
	input: AcceptInvitationInput
): Promise<AcceptedInvitation> {
	const token = normalizeInvitationToken(input?.token);
	const hasOnboarding = input.name !== undefined || input.password !== undefined;
	// Hash before the transaction (and whenever a password is sent) so the slow KDF does not hold
	// locks and does not create a timing difference between new and existing identities.
	const onboarding = hasOnboarding ? validateOnboarding(input.name, input.password) : null;
	const passwordHash = onboarding ? await hashPassword(onboarding.password) : null;
	const execute = async (tx: IncidentDatabase): Promise<AcceptedInvitation> => {
		const { invitation, organizationName } = await loadUsableInvitation(tx, token, true);
		const [owner] = await tx
			.select({ userId: userEmails.userId })
			.from(userEmails)
			.where(sql`lower(${userEmails.email}) = ${invitation.email}`)
			.limit(1)
			.for('share');
		if (input.principalUserId !== null && input.principalUserId !== owner?.userId)
			throw new IncidentServiceError('INVALID_ACCEPTOR', 'Invitation belongs to another identity');

		let userId: string;
		if (owner) {
			if (input.principalUserId === null)
				throw new IncidentServiceError('AUTHENTICATION_REQUIRED', 'Sign in to accept');
			if (hasOnboarding) throw invalidInput('onboarding fields are not accepted when signed in');
			const [user] = await tx
				.select({ active: users.active })
				.from(users)
				.where(eq(users.id, owner.userId))
				.for('share');
			if (!user?.active) throw new IncidentServiceError('INVALID_ACCEPTOR', 'Inactive identity');
			userId = owner.userId;
		} else {
			if (!onboarding || !passwordHash) throw invalidInput('name and password are required');
			const now = new Date();
			const [user] = await tx
				.insert(users)
				.values({ name: onboarding.name })
				.returning({ id: users.id });
			userId = user.id;
			await tx
				.insert(userEmails)
				.values({ userId, email: invitation.email, isPrimary: true, verifiedAt: now });
			await tx.insert(authUsers).values({
				id: userId,
				name: onboarding.name,
				email: invitation.email,
				emailVerified: true
			});
			await tx.insert(authAccounts).values({
				userId,
				accountId: userId,
				providerId: 'credential',
				password: passwordHash
			});
		}

		const [membership] = await tx
			.select({ id: memberships.id, active: memberships.active })
			.from(memberships)
			.where(
				and(
					eq(memberships.organizationId, invitation.organizationId),
					eq(memberships.userId, userId)
				)
			)
			.limit(1)
			.for('update');
		// An inactive membership is never reactivated as a side effect of an invitation.
		if (membership && !membership.active)
			throw new IncidentServiceError('ACCEPTANCE_CONFLICT', 'Membership is not active');
		const membershipId =
			membership?.id ??
			(
				await tx
					.insert(memberships)
					.values({ organizationId: invitation.organizationId, userId, active: true })
					.returning({ id: memberships.id })
			)[0].id;
		await tx
			.insert(roleAssignments)
			.values({
				organizationId: invitation.organizationId,
				membershipId,
				roleId: invitation.roleId,
				scopeType: 'organization'
			})
			.onConflictDoNothing();
		const acceptedAt = new Date();
		await tx
			.update(invitations)
			.set({ status: 'accepted', acceptedAt, updatedAt: acceptedAt })
			.where(and(eq(invitations.id, invitation.id), eq(invitations.status, 'pending')));
		return { organizationName, requiresLogin: input.principalUserId === null };
	};
	try {
		if ('transaction' in db && typeof db.transaction === 'function')
			return await db.transaction(async (tx) => execute(tx));
		return await execute(db);
	} catch (error) {
		// e.g. the same email provisioned concurrently by another acceptance: nothing was written;
		// retrying resolves to the existing identity (which then requires signing in).
		if (!(error instanceof IncidentServiceError) && isUniqueViolation(error))
			throw new IncidentServiceError('ACCEPTANCE_CONFLICT', 'Concurrent acceptance');
		throw error;
	}
}
