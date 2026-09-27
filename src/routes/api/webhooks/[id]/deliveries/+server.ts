import type { RequestHandler } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { listWebhookDeliveries } from '$lib/server/services/webhook-subscriptions';
import { failure, success, uuid, webhookContext, webhookFailure } from '../../http';

function decodeCursor(raw: string | null): { createdAt: string; id: string } | null | undefined {
	if (raw === null) return undefined;
	try {
		const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
		if (
			Array.isArray(value) &&
			value.length === 2 &&
			typeof value[0] === 'string' &&
			typeof value[1] === 'string'
		)
			return { createdAt: value[0], id: value[1] };
	} catch {
		// fall through
	}
	return null;
}

/**
 * GET /api/webhooks/<id>/deliveries?organizationId=<UUID>[&limit=1..100][&cursor=…]
 * (webhooks:view). Read-only history, newest first: status, attempts, last status/error code,
 * timings. Never the body, secret or response content.
 */
export const GET: RequestHandler = async (event) => {
	try {
		const ctx = await webhookContext(event, 'webhooks:view', {
			mutation: false,
			allowedQuery: ['limit', 'cursor']
		});
		if ('response' in ctx) return ctx.response;
		if (!uuid.test(event.params.id ?? ''))
			return failure(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
		const query = event.url.searchParams;
		const rawLimit = query.get('limit');
		const limit =
			rawLimit === null ? undefined : /^\d{1,3}$/.test(rawLimit) ? Number(rawLimit) : NaN;
		const before = decodeCursor(query.get('cursor'));
		if (Number.isNaN(limit) || before === null)
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		const page = await listWebhookDeliveries(db, ctx.organizationId, event.params.id, {
			limit,
			before
		});
		return success({
			deliveries: page.deliveries,
			nextCursor: page.next
				? Buffer.from(JSON.stringify([page.next.createdAt, page.next.id])).toString('base64url')
				: null
		});
	} catch (error) {
		return webhookFailure(error);
	}
};
