import type { RequestHandler } from '@sveltejs/kit';
import { rotateWebhookSecret } from '$lib/server/services/webhook-subscriptions';
import {
	asWebhookManager,
	failure,
	success,
	uuid,
	webhookContext,
	webhookFailure
} from '../../http';
import { withAudit } from '$lib/server/services/audit-events';

/**
 * POST /api/webhooks/<id>/rotate-secret?organizationId=<UUID>   (webhooks:manage, same Origin,
 * no body). 200 { webhook, secret } — the new secret is returned only here. Deliveries created
 * before the rotation keep being signed with the version they recorded.
 */
export const POST: RequestHandler = async (event) => {
	try {
		const ctx = await webhookContext(event, 'webhooks:manage', { mutation: true });
		if ('response' in ctx) return ctx.response;
		if (!uuid.test(event.params.id ?? ''))
			return failure(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
		if (event.request.body !== null)
			return failure(400, 'INVALID_INPUT', 'Request body is not allowed.');
		const id = event.params.id;
		return success(
			await asWebhookManager(ctx, (tx) =>
				withAudit(
					tx,
					ctx.organizationId,
					ctx.actorUserId,
					() => rotateWebhookSecret(tx, ctx.organizationId, id),
					// The new secret is returned to the caller once and never audited.
					() => ({ action: 'webhook.secret_rotated', entityType: 'webhook', entityId: id })
				)
			)
		);
	} catch (error) {
		return webhookFailure(error);
	}
};
