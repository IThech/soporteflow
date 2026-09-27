import { and, eq, sql } from 'drizzle-orm';
import { webhookDeliveries, webhookSubscriptions } from '../db/schema';
import type { IncidentDatabase } from './incidents';
import type { StoredAutomationEvent } from './automation-events';

/**
 * Webhook fanout (5.4V-B). Pure database work, no HTTP: called by automation-event-producer right
 * after each automation event is appended, on the SAME transaction. For every active subscription
 * of the event's organization that lists the event type, it inserts one delivery intent with the
 * exact body to send, the target URL and the current secret version (snapshots).
 *
 * Why here and not a scanner: automation_events.position is assigned at insert time, not commit
 * time, so a "WHERE position > last_seen" cursor can permanently skip an event committed after a
 * higher position was already read. Fanning out inside the producing transaction means an event
 * and its intents commit (or roll back) together; nothing is ever discovered later.
 *
 * Idempotent: UNIQUE (subscription_id, event_id) + ON CONFLICT DO NOTHING.
 * Cost with no subscriptions: one indexed query per event.
 */

export const WEBHOOK_BODY_MAX_BYTES = 32 * 1024;

/** Stable public envelope (key order fixed). Never secrets or subscription data. */
export function serializeWebhookBody(event: StoredAutomationEvent): string {
	const body = JSON.stringify({
		id: event.id,
		type: event.eventType,
		schemaVersion: event.schemaVersion,
		occurredAt: event.occurredAt,
		organizationId: event.organizationId,
		aggregate: { type: event.aggregateType, id: event.aggregateId },
		data: event.payload
	});
	if (Buffer.byteLength(body, 'utf8') > WEBHOOK_BODY_MAX_BYTES)
		throw new Error('WEBHOOK_BODY_TOO_LARGE');
	return body;
}

export async function fanoutWebhookDeliveries(
	tx: IncidentDatabase,
	event: StoredAutomationEvent
): Promise<{ created: number }> {
	const subscriptions = await tx
		.select({
			id: webhookSubscriptions.id,
			targetUrl: webhookSubscriptions.targetUrl,
			secretVersion: webhookSubscriptions.currentSecretVersion
		})
		.from(webhookSubscriptions)
		.where(
			and(
				eq(webhookSubscriptions.organizationId, event.organizationId),
				eq(webhookSubscriptions.active, true),
				sql`${webhookSubscriptions.eventTypes} @> ${JSON.stringify([event.eventType])}::jsonb`
			)
		)
		.orderBy(webhookSubscriptions.id);
	if (subscriptions.length === 0) return { created: 0 };
	const body = serializeWebhookBody(event);
	const rows = await tx
		.insert(webhookDeliveries)
		.values(
			subscriptions.map((subscription) => ({
				organizationId: event.organizationId,
				subscriptionId: subscription.id,
				eventId: event.id,
				eventType: event.eventType,
				targetUrl: subscription.targetUrl,
				secretVersion: subscription.secretVersion,
				body
			}))
		)
		.onConflictDoNothing({
			target: [webhookDeliveries.subscriptionId, webhookDeliveries.eventId]
		})
		.returning({ id: webhookDeliveries.id });
	return { created: rows.length };
}
