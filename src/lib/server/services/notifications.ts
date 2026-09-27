import { and, desc, eq, isNull, isNotNull, sql } from 'drizzle-orm';
import { notifications, memberships, organizations, users } from '../db/schema';
import type { IncidentDatabase } from './incidents';
import type { NotificationDto, NotificationPage } from '$lib/api/notifications';

export class NotificationServiceError extends Error {
	constructor(readonly code: 'INVALID_INPUT' | 'FORBIDDEN' | 'NOTIFICATION_NOT_FOUND') {
		super(code);
		this.name = 'NotificationServiceError';
	}
}
export interface NotificationContext {
	organizationId: string;
	recipientUserId: string;
}
export interface CreateNotificationInput extends NotificationContext {
	type: string;
	title: string;
	message: string;
	payload?: Record<string, unknown> | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const typePattern = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;
const invalid = () => new NotificationServiceError('INVALID_INPUT');
const notFound = () => new NotificationServiceError('NOTIFICATION_NOT_FOUND');
function validId(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !uuid.test(value)) throw invalid();
}
function text(value: unknown, max: number): string {
	if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\u0000'))
		throw invalid();
	return value.trim();
}
/** Internal metadata only. No public payload contract in U-A. Producers must never supply secrets. */
function metadata(value: unknown): Record<string, unknown> | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object' || Array.isArray(value)) throw invalid();
	const seen = new Set<object>();
	let nodes = 0;
	function validate(v: unknown, depth: number): void {
		if (++nodes > 512 || depth > 8) throw invalid();
		if (v === null || typeof v === 'boolean') return;
		if (typeof v === 'string') {
			if (v.includes('\u0000')) throw invalid();
			return;
		}
		if (typeof v === 'number' && Number.isFinite(v)) return;
		if (typeof v !== 'object' || seen.has(v)) throw invalid();
		seen.add(v);
		if (
			!Array.isArray(v) &&
			Object.getPrototypeOf(v) !== Object.prototype &&
			Object.getPrototypeOf(v) !== null
		)
			throw invalid();
		for (const key of Object.keys(v)) {
			if (
				/password|secret|token|authorization|cookie|credential|__proto__|prototype|constructor/i.test(
					key
				) ||
				key.includes('\u0000')
			)
				throw invalid();
			const descriptor = Object.getOwnPropertyDescriptor(v, key);
			if (!descriptor || !('value' in descriptor)) throw invalid();
			validate(descriptor.value, depth + 1);
		}
		seen.delete(v);
	}
	validate(value, 0);
	const encoded = JSON.stringify(value);
	// Leave room for JSONB's canonical spacing; DB also enforces its exact serialized size.
	if (Buffer.byteLength(encoded, 'utf8') > 4096) throw invalid();
	return JSON.parse(encoded) as Record<string, unknown>;
}
const columns = {
	id: notifications.id,
	type: notifications.type,
	title: notifications.title,
	message: notifications.message,
	readAt: sql<
		string | null
	>`to_char(${notifications.readAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
	createdAt: sql<string>`to_char(${notifications.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
	updatedAt: sql<string>`to_char(${notifications.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
};
function scope(context: NotificationContext) {
	return and(
		eq(notifications.organizationId, context.organizationId),
		eq(notifications.recipientUserId, context.recipientUserId)
	);
}
/** Membership, user and org rows are rechecked/locked inside the operation's transaction. */
async function authorized<T>(
	db: IncidentDatabase,
	context: NotificationContext,
	run: (tx: IncidentDatabase) => Promise<T>
): Promise<T> {
	validId(context.organizationId);
	validId(context.recipientUserId);
	return db.transaction(async (tx) => {
		const [member] = await tx
			.select({ id: memberships.id })
			.from(memberships)
			.innerJoin(users, eq(users.id, memberships.userId))
			.innerJoin(organizations, eq(organizations.id, memberships.organizationId))
			.where(
				and(
					eq(memberships.organizationId, context.organizationId),
					eq(memberships.userId, context.recipientUserId),
					eq(memberships.active, true),
					eq(users.active, true),
					eq(organizations.status, 'active')
				)
			)
			.limit(1)
			.for('share');
		if (!member) throw new NotificationServiceError('FORBIDDEN');
		return run(tx);
	});
}
async function find(
	tx: IncidentDatabase,
	context: NotificationContext,
	id: string
): Promise<NotificationDto> {
	const [row] = await tx
		.select(columns)
		.from(notifications)
		.where(and(scope(context), eq(notifications.id, id)))
		.limit(1);
	if (!row) throw notFound();
	return row;
}
/** Server-only; not exposed through POST. Domain events reach it only via notification-producer (U-C). */
export async function createNotification(
	db: IncidentDatabase,
	input: CreateNotificationInput
): Promise<NotificationDto> {
	const type = text(input.type, 80);
	if (!typePattern.test(type)) throw invalid();
	const title = text(input.title, 160),
		message = text(input.message, 2000),
		payload = metadata(input.payload);
	return authorized(db, input, async (tx) => {
		const [row] = await tx
			.insert(notifications)
			.values({
				organizationId: input.organizationId,
				recipientUserId: input.recipientUserId,
				type,
				title,
				message,
				payload
			})
			.returning({ id: notifications.id });
		return find(tx, input, row.id);
	});
}
type Cursor = { at: string; id: string };
export interface NotificationListOptions {
	status?: 'read' | 'unread';
	limit?: number;
	cursor?: string;
}
function encode(cursor: Cursor) {
	return Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString('base64url');
}
function decode(value: string): Cursor {
	try {
		if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
		const v: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
		if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== 'string' || typeof v[1] !== 'string')
			throw invalid();
		validId(v[1]);
		if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v[0])) throw invalid();
		const millis = v[0].slice(0, 23) + 'Z';
		if (new Date(millis).toISOString() !== millis) throw invalid();
		const cursor = { at: v[0], id: v[1] };
		if (encode(cursor) !== value) throw invalid();
		return cursor;
	} catch {
		throw invalid();
	}
}
export async function listNotifications(
	db: IncidentDatabase,
	context: NotificationContext,
	options: NotificationListOptions = {}
): Promise<NotificationPage> {
	const limit = options.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
	if (options.status !== undefined && options.status !== 'read' && options.status !== 'unread')
		throw invalid();
	const cursor = options.cursor === undefined ? null : decode(options.cursor);
	return authorized(db, context, async (tx) => {
		const conditions = [scope(context)];
		if (options.status)
			conditions.push(
				options.status === 'read' ? isNotNull(notifications.readAt) : isNull(notifications.readAt)
			);
		if (cursor)
			conditions.push(
				sql`(${notifications.createdAt},${notifications.id}) < (${cursor.at}::timestamptz,${cursor.id}::uuid)`
			);
		const rows = await tx
			.select(columns)
			.from(notifications)
			.where(and(...conditions))
			.orderBy(desc(notifications.createdAt), desc(notifications.id))
			.limit(limit + 1);
		const items = rows.slice(0, limit),
			last = items.at(-1);
		return {
			items,
			nextCursor: rows.length > limit && last ? encode({ at: last.createdAt, id: last.id }) : null
		};
	});
}
export async function getNotification(
	db: IncidentDatabase,
	context: NotificationContext,
	id: string
) {
	validId(id);
	return authorized(db, context, (tx) => find(tx, context, id));
}
async function mark(db: IncidentDatabase, context: NotificationContext, id: string, read: boolean) {
	validId(id);
	return authorized(db, context, async (tx) => {
		// Atomic CASE preserves timestamps on repeated requests, including concurrent retries.
		const changed = read ? isNull(notifications.readAt) : isNotNull(notifications.readAt);
		const [row] = await tx
			.update(notifications)
			.set({
				readAt: read ? sql`coalesce(${notifications.readAt},now())` : null,
				updatedAt: sql`case when ${changed} then now() else ${notifications.updatedAt} end`
			})
			.where(and(scope(context), eq(notifications.id, id)))
			.returning(columns);
		if (!row) throw notFound();
		return row;
	});
}
export const markNotificationRead = (db: IncidentDatabase, c: NotificationContext, id: string) =>
	mark(db, c, id, true);
export const markNotificationUnread = (db: IncidentDatabase, c: NotificationContext, id: string) =>
	mark(db, c, id, false);
export async function markAllNotificationsRead(
	db: IncidentDatabase,
	context: NotificationContext
): Promise<void> {
	return authorized(db, context, async (tx) => {
		await tx
			.update(notifications)
			.set({ readAt: sql`now()`, updatedAt: sql`now()` })
			.where(and(scope(context), isNull(notifications.readAt)));
	});
}
export async function deleteNotification(
	db: IncidentDatabase,
	context: NotificationContext,
	id: string
): Promise<void> {
	validId(id);
	return authorized(db, context, async (tx) => {
		const rows = await tx
			.delete(notifications)
			.where(and(scope(context), eq(notifications.id, id)))
			.returning({ id: notifications.id });
		if (!rows.length) throw notFound();
	});
}
export async function clearNotifications(
	db: IncidentDatabase,
	context: NotificationContext,
	selection: 'read' | 'all'
): Promise<void> {
	if (selection !== 'read' && selection !== 'all') throw invalid();
	return authorized(db, context, async (tx) => {
		await tx
			.delete(notifications)
			.where(
				and(scope(context), selection === 'read' ? isNotNull(notifications.readAt) : undefined)
			);
	});
}
export async function countUnreadNotifications(
	db: IncidentDatabase,
	context: NotificationContext
): Promise<number> {
	return authorized(db, context, async (tx) => {
		const [row] = await tx
			.select({ value: sql<number>`count(*)::int` })
			.from(notifications)
			.where(and(scope(context), isNull(notifications.readAt)));
		return row.value;
	});
}
