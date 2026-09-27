import { and, eq, inArray, sql } from 'drizzle-orm';
import { memberships, notificationPreferences, organizations, users } from '../db/schema';
import {
	NOTIFICATION_EVENT_DEFAULTS,
	NOTIFICATION_EVENT_TYPES,
	isNotificationEventType,
	type NotificationChannel,
	type NotificationEventType
} from '../../notifications/events';
import type { IncidentDatabase } from './incidents';

/**
 * Personal notification preferences (5.4U-B). A user only reads/changes their own preferences in
 * one organization; no admin override and no notifications:* capability (personal resource, like
 * the inbox). Stored rows are overrides; missing rows resolve to the catalog default.
 * Preferences are per (organization, user): the same user can mute an event in one organization
 * and keep it in another.
 *
 * 5.4U-D: two independent channels, in-app and email. Each stored column is an override for its
 * channel only (NULL = that channel's catalog default: in-app ON, email OFF). A row whose two
 * columns would be NULL is deleted, so "no row" and "all defaults" are the same state.
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
	emailEnabled: boolean;
	/** true when the in-app channel has no override (the value is the catalog default). */
	inAppIsDefault: boolean;
	/** true when the email channel has no override (the value is the catalog default). */
	emailIsDefault: boolean;
}

/**
 * Partial update: only the channels present change. boolean = explicit override; null = back to
 * that channel's default. At least one channel is required; no other key is accepted.
 */
export interface NotificationPreferenceUpdate {
	inAppEnabled?: boolean | null;
	emailEnabled?: boolean | null;
}

type Override = { inApp: boolean | null; email: boolean | null };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new NotificationPreferenceError('INVALID_INPUT');

function validId(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !uuid.test(value)) throw invalid();
}
function validEventType(value: unknown): asserts value is NotificationEventType {
	if (!isNotificationEventType(value)) throw invalid();
}
function validChannel(value: unknown): asserts value is NotificationChannel {
	if (value !== 'in_app' && value !== 'email') throw invalid();
}
function parseUpdate(value: unknown): NotificationPreferenceUpdate {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
	const keys = Object.keys(value);
	if (keys.length === 0 || keys.some((k) => k !== 'inAppEnabled' && k !== 'emailEnabled'))
		throw invalid();
	const update = value as Record<string, unknown>;
	for (const key of keys)
		if (update[key] !== null && typeof update[key] !== 'boolean') throw invalid();
	return update as NotificationPreferenceUpdate;
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
	override: Override | undefined
): NotificationPreferenceDto {
	const defaults = NOTIFICATION_EVENT_DEFAULTS[eventType];
	const inApp = override?.inApp ?? null;
	const email = override?.email ?? null;
	return {
		eventType,
		inAppEnabled: inApp ?? defaults.inAppEnabled,
		emailEnabled: email ?? defaults.emailEnabled,
		inAppIsDefault: inApp === null,
		emailIsDefault: email === null
	};
}

const overrideColumns = {
	eventType: notificationPreferences.eventType,
	inApp: notificationPreferences.inAppEnabled,
	email: notificationPreferences.emailEnabled
};

async function overrides(
	tx: IncidentDatabase,
	context: NotificationPreferenceContext
): Promise<Map<string, Override>> {
	const rows = await tx.select(overrideColumns).from(notificationPreferences).where(scope(context));
	return new Map(rows.map((row) => [row.eventType, { inApp: row.inApp, email: row.email }]));
}

/** Every catalogued event with its effective values, in catalog order (one query). */
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

/**
 * Partial per-channel update (idempotent; updated_at only moves when a value changes). Channels
 * not present keep their current override. If both channels end up at default, the row is deleted.
 */
export async function setNotificationPreference(
	db: IncidentDatabase,
	context: NotificationPreferenceContext,
	eventType: unknown,
	input: unknown
): Promise<NotificationPreferenceDto> {
	validEventType(eventType);
	const update = parseUpdate(input);
	return authorized(db, context, async (tx) => {
		const [current] = await tx
			.select(overrideColumns)
			.from(notificationPreferences)
			.where(and(scope(context), eq(notificationPreferences.eventType, eventType)))
			.limit(1)
			.for('update');
		const next: Override = {
			inApp: update.inAppEnabled !== undefined ? update.inAppEnabled : (current?.inApp ?? null),
			email: update.emailEnabled !== undefined ? update.emailEnabled : (current?.email ?? null)
		};
		if (next.inApp === null && next.email === null) {
			await tx
				.delete(notificationPreferences)
				.where(and(scope(context), eq(notificationPreferences.eventType, eventType)));
			return effective(eventType, undefined);
		}
		await tx
			.insert(notificationPreferences)
			.values({
				organizationId: context.organizationId,
				userId: context.userId,
				eventType,
				inAppEnabled: next.inApp,
				emailEnabled: next.email
			})
			.onConflictDoUpdate({
				target: [
					notificationPreferences.organizationId,
					notificationPreferences.userId,
					notificationPreferences.eventType
				],
				set: {
					inAppEnabled: next.inApp,
					emailEnabled: next.email,
					updatedAt: sql`case when ${notificationPreferences.inAppEnabled} is distinct from ${next.inApp}::boolean or ${notificationPreferences.emailEnabled} is distinct from ${next.email}::boolean then now() else ${notificationPreferences.updatedAt} end`
				}
			});
		return effective(eventType, next);
	});
}

/** Removes the override of both channels (back to the defaults). Idempotent. */
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
 * Effective preference of one channel for one user (default channel: in-app). Pure read, no
 * membership check (recipient resolution already filters inactive members).
 */
export async function isNotificationEnabled(
	db: IncidentDatabase,
	input: {
		organizationId: string;
		userId: string;
		eventType: unknown;
		channel?: NotificationChannel;
	}
): Promise<boolean> {
	validId(input?.organizationId);
	validId(input.userId);
	validEventType(input.eventType);
	const channel = input.channel ?? 'in_app';
	validChannel(channel);
	const [row] = await db
		.select(overrideColumns)
		.from(notificationPreferences)
		.where(
			and(
				eq(notificationPreferences.organizationId, input.organizationId),
				eq(notificationPreferences.userId, input.userId),
				eq(notificationPreferences.eventType, input.eventType)
			)
		)
		.limit(1);
	const value = effective(input.eventType, row);
	return channel === 'email' ? value.emailEnabled : value.inAppEnabled;
}

/**
 * Batched per-channel resolution: which of userIds have the event enabled in each channel in this
 * organization (one query, no N+1). Both lists keep the input order. Channels are independent.
 */
export async function resolveNotificationChannels(
	db: IncidentDatabase,
	input: { organizationId: string; eventType: unknown; userIds: readonly string[] }
): Promise<{ inApp: string[]; email: string[] }> {
	validId(input?.organizationId);
	validEventType(input.eventType);
	const eventType = input.eventType;
	input.userIds.forEach((id) => validId(id));
	if (input.userIds.length === 0) return { inApp: [], email: [] };
	const rows = await db
		.select({
			userId: notificationPreferences.userId,
			inApp: notificationPreferences.inAppEnabled,
			email: notificationPreferences.emailEnabled
		})
		.from(notificationPreferences)
		.where(
			and(
				eq(notificationPreferences.organizationId, input.organizationId),
				eq(notificationPreferences.eventType, eventType),
				inArray(notificationPreferences.userId, [...input.userIds])
			)
		);
	const stored = new Map(rows.map((row) => [row.userId, row]));
	const values = input.userIds.map((id) => ({ id, value: effective(eventType, stored.get(id)) }));
	return {
		inApp: values.filter((v) => v.value.inAppEnabled).map((v) => v.id),
		email: values.filter((v) => v.value.emailEnabled).map((v) => v.id)
	};
}

/** Single-channel form of resolveNotificationChannels (default channel: in-app). */
export async function filterUsersWithNotificationEnabled(
	db: IncidentDatabase,
	input: {
		organizationId: string;
		eventType: unknown;
		userIds: readonly string[];
		channel?: NotificationChannel;
	}
): Promise<string[]> {
	const channel = input?.channel ?? 'in_app';
	validChannel(channel);
	const resolved = await resolveNotificationChannels(db, input);
	return channel === 'email' ? resolved.email : resolved.inApp;
}
