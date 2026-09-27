import { and, eq, inArray, sql } from 'drizzle-orm';
import { memberships, notificationPreferences, organizations, users } from '../db/schema';
import {
	NOTIFICATION_EVENT_DEFAULTS,
	NOTIFICATION_EVENT_TYPES,
	isNotificationEventType,
	type NotificationEventType
} from '../../notifications/events';
import type { IncidentDatabase } from './incidents';

/**
 * Personal notification preferences (5.4U-B). A user only reads/changes their own preferences in
 * one organization; no admin override and no notifications:* capability (personal resource, like
 * the inbox). Stored rows are overrides; missing rows resolve to the catalog default.
 * Preferences are per (organization, user): the same user can mute an event in one organization
 * and keep it in another.
 */

export class NotificationPreferenceError extends Error {
	constructor(readonly code: 'INVALID_INPUT' | 'FORBIDDEN') {
		super(code);
		this.name = 'NotificationPreferenceError';
	}
}

export interface NotificationPreferenceContext {
	organizationId: string;
	userId: string;
}

export interface NotificationPreferenceDto {
	eventType: NotificationEventType;
	inAppEnabled: boolean;
	/** true when no override is stored (the value is the catalog default). */
	isDefault: boolean;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new NotificationPreferenceError('INVALID_INPUT');

function validId(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !uuid.test(value)) throw invalid();
}
function validEventType(value: unknown): asserts value is NotificationEventType {
	if (!isNotificationEventType(value)) throw invalid();
}

/** Same rule as the inbox: active user, active membership, active organization (rows FOR SHARE). */
async function authorized<T>(
	db: IncidentDatabase,
	context: NotificationPreferenceContext,
	run: (tx: IncidentDatabase) => Promise<T>
): Promise<T> {
	validId(context?.organizationId);
	validId(context.userId);
	return db.transaction(async (tx) => {
		const [member] = await tx
			.select({ id: memberships.id })
			.from(memberships)
			.innerJoin(users, eq(users.id, memberships.userId))
			.innerJoin(organizations, eq(organizations.id, memberships.organizationId))
			.where(
				and(
					eq(memberships.organizationId, context.organizationId),
					eq(memberships.userId, context.userId),
					eq(memberships.active, true),
					eq(users.active, true),
					eq(organizations.status, 'active')
				)
			)
			.limit(1)
			.for('share');
		if (!member) throw new NotificationPreferenceError('FORBIDDEN');
		return run(tx);
	});
}

function scope(context: NotificationPreferenceContext) {
	return and(
		eq(notificationPreferences.organizationId, context.organizationId),
		eq(notificationPreferences.userId, context.userId)
	);
}

function effective(
	eventType: NotificationEventType,
	override: boolean | undefined
): NotificationPreferenceDto {
	return override === undefined
		? {
				eventType,
				inAppEnabled: NOTIFICATION_EVENT_DEFAULTS[eventType].inAppEnabled,
				isDefault: true
			}
		: { eventType, inAppEnabled: override, isDefault: false };
}

async function overrides(
	tx: IncidentDatabase,
	context: NotificationPreferenceContext
): Promise<Map<string, boolean>> {
	const rows = await tx
		.select({
			eventType: notificationPreferences.eventType,
			inAppEnabled: notificationPreferences.inAppEnabled
		})
		.from(notificationPreferences)
		.where(scope(context));
	return new Map(rows.map((row) => [row.eventType, row.inAppEnabled]));
}

/** Every catalogued event with its effective value, in catalog order (one query). */
export async function listNotificationPreferences(
	db: IncidentDatabase,
	context: NotificationPreferenceContext
): Promise<NotificationPreferenceDto[]> {
	return authorized(db, context, async (tx) => {
		const stored = await overrides(tx, context);
		return NOTIFICATION_EVENT_TYPES.map((eventType) => effective(eventType, stored.get(eventType)));
	});
}

export async function getNotificationPreference(
	db: IncidentDatabase,
	context: NotificationPreferenceContext,
	eventType: unknown
): Promise<NotificationPreferenceDto> {
	validEventType(eventType);
	return authorized(db, context, async (tx) =>
		effective(eventType, (await overrides(tx, context)).get(eventType))
	);
}

/** Upsert of the final value (idempotent; updated_at only moves when the value changes). */
export async function setNotificationPreference(
	db: IncidentDatabase,
	context: NotificationPreferenceContext,
	eventType: unknown,
	inAppEnabled: unknown
): Promise<NotificationPreferenceDto> {
	validEventType(eventType);
	if (typeof inAppEnabled !== 'boolean') throw invalid();
	return authorized(db, context, async (tx) => {
		await tx
			.insert(notificationPreferences)
			.values({
				organizationId: context.organizationId,
				userId: context.userId,
				eventType,
				inAppEnabled
			})
			.onConflictDoUpdate({
				target: [
					notificationPreferences.organizationId,
					notificationPreferences.userId,
					notificationPreferences.eventType
				],
				set: {
					inAppEnabled,
					updatedAt: sql`case when ${notificationPreferences.inAppEnabled} is distinct from ${inAppEnabled} then now() else ${notificationPreferences.updatedAt} end`
				}
			});
		return effective(eventType, inAppEnabled);
	});
}

/** Removes the override (back to the default). Idempotent: no row is not an error. */
export async function resetNotificationPreference(
	db: IncidentDatabase,
	context: NotificationPreferenceContext,
	eventType: unknown
): Promise<NotificationPreferenceDto> {
	validEventType(eventType);
	return authorized(db, context, async (tx) => {
		await tx
			.delete(notificationPreferences)
			.where(and(scope(context), eq(notificationPreferences.eventType, eventType)));
		return effective(eventType, undefined);
	});
}

/**
 * Effective in-app preference for one user (for 5.4U-C). Pure read, no side effects, no
 * membership check (recipient resolution already filters inactive members).
 */
export async function isNotificationEnabled(
	db: IncidentDatabase,
	input: { organizationId: string; userId: string; eventType: unknown }
): Promise<boolean> {
	validId(input?.organizationId);
	validId(input.userId);
	validEventType(input.eventType);
	const [row] = await db
		.select({ inAppEnabled: notificationPreferences.inAppEnabled })
		.from(notificationPreferences)
		.where(
			and(
				eq(notificationPreferences.organizationId, input.organizationId),
				eq(notificationPreferences.userId, input.userId),
				eq(notificationPreferences.eventType, input.eventType)
			)
		)
		.limit(1);
	return row ? row.inAppEnabled : NOTIFICATION_EVENT_DEFAULTS[input.eventType].inAppEnabled;
}

/**
 * Batched form: which of userIds have the event enabled in this organization (one query, no N+1).
 * Returns the enabled ids in the input order.
 */
export async function filterUsersWithNotificationEnabled(
	db: IncidentDatabase,
	input: { organizationId: string; eventType: unknown; userIds: readonly string[] }
): Promise<string[]> {
	validId(input?.organizationId);
	validEventType(input.eventType);
	input.userIds.forEach((id) => validId(id));
	if (input.userIds.length === 0) return [];
	const rows = await db
		.select({
			userId: notificationPreferences.userId,
			inAppEnabled: notificationPreferences.inAppEnabled
		})
		.from(notificationPreferences)
		.where(
			and(
				eq(notificationPreferences.organizationId, input.organizationId),
				eq(notificationPreferences.eventType, input.eventType),
				inArray(notificationPreferences.userId, [...input.userIds])
			)
		);
	const stored = new Map(rows.map((row) => [row.userId, row.inAppEnabled]));
	const fallback = NOTIFICATION_EVENT_DEFAULTS[input.eventType].inAppEnabled;
	return input.userIds.filter((id) => stored.get(id) ?? fallback);
}
