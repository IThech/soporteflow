import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import {
	deactivateWebhookSubscription,
	getWebhookSubscription,
	updateWebhookSubscription
} from '$lib/server/services/webhook-subscriptions';
import {
	failure,
	noContent,
	readWebhookJson,
	success,
	uuid,
	webhookContext,
	webhookFailure
} from '../http';

/** GET /api/webhooks/<id>?organizationId=<UUID>   (webhooks:view). Never the secret. */
export const GET: RequestHandler = async (event) => {
	try {
		const ctx = await webhookContext(event, 'webhooks:view', { mutation: false });
		if ('response' in ctx) return ctx.response;
		if (!uuid.test(event.params.id ?? ''))
			return failure(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
		return success({
			webhook: await getWebhookSubscription(db, ctx.organizationId, event.params.id)
		});
	} catch (error) {
		return webhookFailure(error);
	}
};

/**
 * PATCH /api/webhooks/<id>?organizationId=<UUID>   (webhooks:manage, same Origin)
 * body: strict subset of { name, targetUrl, eventTypes, active }, at least one key. Secrets are
 * rotated through POST /api/webhooks/<id>/rotate-secret only.
 */
export const PATCH: RequestHandler = async (event) => {
	try {
		const ctx = await webhookContext(event, 'webhooks:manage', { mutation: true });
		if ('response' in ctx) return ctx.response;
		if (!uuid.test(event.params.id ?? ''))
			return failure(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
		const body = await readWebhookJson(event.request);
		if (!body) return failure(400, 'INVALID_INPUT', 'Invalid request.');
		return success({
			webhook: await updateWebhookSubscription(db, ctx.organizationId, event.params.id, body)
		});
	} catch (error) {
		return webhookFailure(error);
	}
};

/**
 * DELETE /api/webhooks/<id>?organizationId=<UUID>   (webhooks:manage, same Origin, no body)
 * Deactivates the subscription (idempotent 204): no new intents, pending deliveries are not sent,
 * delivery history is kept.
 */
export const DELETE: RequestHandler = async (event) => {
	try {
		const ctx = await webhookContext(event, 'webhooks:manage', { mutation: true });
		if ('response' in ctx) return ctx.response;
		if (!uuid.test(event.params.id ?? ''))
			return failure(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
		if (event.request.body !== null)
			return failure(400, 'INVALID_INPUT', 'Request body is not allowed.');
		await deactivateWebhookSubscription(db, ctx.organizationId, event.params.id);
		return noContent();
	} catch (error) {
		return webhookFailure(error);
	}
};
