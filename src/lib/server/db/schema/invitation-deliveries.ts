import { sql } from 'drizzle-orm';
import {
	check,
	foreignKey,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar
} from 'drizzle-orm/pg-core';
import { invitations } from './auth';

/**
 * Invitation email outbox (5.4X-C). One row per delivery attempt chain of ONE invitation token:
 *
 * - Created in the SAME transaction as the invitation (or its explicit resend) together with the
 *   token hash, so an invitation never exists without its delivery intent and vice versa.
 * - The raw token needed by the email link is stored ONLY as AES-256-GCM ciphertext under the
 *   independent key INVITATION_TOKEN_ENCRYPTION_KEY (random 12-byte IV per encryption, auth tag,
 *   AAD bound to invitation id + delivery id). Never plaintext.
 * - The ciphertext exists only while the delivery is in flight (pending/processing/retry). Every
 *   terminal state — sent, failed (incl. MAX_ATTEMPTS), cancelled (resend, revoke, accept,
 *   expiry) — nulls it. Enforced by `invitation_deliveries_token_state_check`.
 * - Retries of the same delivery reuse the same ciphertext (same link); an explicit resend
 *   cancels the active delivery and creates a new one with a new token.
 * - At most one active delivery per invitation (partial unique index).
 * - Claim/lease/retry/exhaustion follow notification_deliveries (5.4U-D/5.4W-A).
 */
export const invitationDeliveries = pgTable(
	'invitation_deliveries',
	{
		id: uuid('id').primaryKey(),
		organizationId: uuid('organization_id').notNull(),
		invitationId: uuid('invitation_id').notNull(),
		status: varchar('status', { length: 20 }).default('pending').notNull(),
		attemptCount: integer('attempt_count').default(0).notNull(),
		/** Next due time (pending/retry) or lease expiry (processing); null when terminal. */
		nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow(),
		leaseToken: uuid('lease_token'),
		lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
		sentAt: timestamp('sent_at', { withTimezone: true }),
		failedAt: timestamp('failed_at', { withTimezone: true }),
		lastErrorCode: varchar('last_error_code', { length: 40 }),
		providerMessageId: varchar('provider_message_id', { length: 255 }),
		tokenCiphertext: text('token_ciphertext'),
		tokenIv: text('token_iv'),
		tokenAuthTag: text('token_auth_tag'),
		createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
	},
	(t) => [
		foreignKey({
			name: 'invitation_deliveries_invitation_org_fk',
			columns: [t.invitationId, t.organizationId],
			foreignColumns: [invitations.id, invitations.organizationId]
		}).onDelete('cascade'),
		check(
			'invitation_deliveries_status_check',
			sql`${t.status} IN ('pending','processing','retry','sent','failed','cancelled')`
		),
		check(
			'invitation_deliveries_lease_check',
			sql`(${t.status} = 'processing') = (${t.leaseToken} IS NOT NULL)`
		),
		check(
			'invitation_deliveries_token_state_check',
			sql`(${t.status} IN ('pending','processing','retry') AND ${t.tokenCiphertext} IS NOT NULL AND ${t.tokenIv} IS NOT NULL AND ${t.tokenAuthTag} IS NOT NULL AND ${t.nextAttemptAt} IS NOT NULL) OR (${t.status} IN ('sent','failed','cancelled') AND ${t.tokenCiphertext} IS NULL AND ${t.tokenIv} IS NULL AND ${t.tokenAuthTag} IS NULL AND ${t.nextAttemptAt} IS NULL)`
		),
		check('invitation_deliveries_attempts_check', sql`${t.attemptCount} >= 0`),
		uniqueIndex('invitation_deliveries_active_unique_idx')
			.on(t.invitationId)
			.where(sql`status IN ('pending','processing','retry')`),
		index('invitation_deliveries_due_idx').on(t.status, t.nextAttemptAt),
		index('invitation_deliveries_invitation_idx').on(t.invitationId, t.createdAt)
	]
);
