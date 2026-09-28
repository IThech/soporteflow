import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	createWebhookSubscription,
	listWebhookSubscriptions
} from '$lib/server/services/webhook-subscriptions';
import {
	asWebhookManager,
	failure,
	readWebhookJson,
	success,
	webhookContext,
	webhookFailure
} from './http';
import { withAudit } from '$lib/server/services/audit-events';

/**
 * GET /api/webhooks?organizationId=<UUID>   (webhooks:view)
 * { webhooks: [{ id, name, targetUrl, active, eventTypes, hasSecret, createdAt, updatedAt }] }.
 * Secrets are never returned.
 */
export const GET: RequestHandler = async (event) => {
	try {
		const ctx = await webhookContext(event, 'webhooks:view', { mutation: false });
		if ('response' in ctx) return ctx.response;
		return success({ webhooks: await listWebhookSubscriptions(db, ctx.organizationId) });
	} catch (error) {
		return webhookFailure(error);
	}
};

/**
 * POST /api/webhooks?organizationId=<UUID>   (webhooks:manage, same Origin)
 * body exactly { name, targetUrl, eventTypes }. 201 { webhook, secret } — the signing secret is
 * returned ONLY in this response.
 */
export const POST: RequestHandler = async (event) => {
	try {
		const ctx = await webhookContext(event, 'webhooks:manage', { mutation: true });
		if ('response' in ctx) return ctx.response;
		const body = await readWebhookJson(event.request);
		if (!body) return failure(400, 'INVALID_INPUT', 'Invalid request.');
		const created = await asWebhookManager(ctx, (tx) =>
			withAudit(
				tx,
				ctx.organizationId,
				ctx.actorUserId,
				() =>
					createWebhookSubscription(
						tx,
						{ organizationId: ctx.organizationId, actorUserId: ctx.actorUserId },
						body
					),
				// Never the target URL (may carry receiver credentials) or the one-time secret.
				(result) => ({
					action: 'webhook.created',
					entityType: 'webhook',
					entityId: result.webhook.id,
					metadata: { eventTypes: [...result.webhook.eventTypes] }
				})
			)
		);
		return success(created, 201);
	} catch (error) {
		return webhookFailure(error);
	}
};
