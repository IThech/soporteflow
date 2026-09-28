import { resultLimitFailure } from '$lib/server/security/bounded-read';
import type { RequestEvent } from '@sveltejs/kit';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { WebhookServiceError } from '$lib/server/services/webhook-subscriptions';
import { db } from '$lib/server/db';
import { withActorAuthorization } from '$lib/server/auth/transactional-authorization';
import type { AuthTransaction } from '$lib/server/auth/instance';
import type { PermissionId } from '$lib/server/auth/permissions';
import {
	actorAuthorizationFailure,
	failure,
	onlyKeys,
	requireCapability,
	uuid
} from '../roles/http';
import { logUnexpectedError } from '$lib/server/logging/logger';

export { failure, success, uuid } from '../roles/http';

const MAX_BODY_BYTES = 8 * 1024;

/**
 * Admin webhook context: organizationId (only query key), session, capability, and for mutations a
 * same-origin Origin header (JSON APIs are not covered by SvelteKit's form CSRF check).
 */
export async function webhookContext(
	event: RequestEvent,
	permissionId: PermissionId,
	options: { mutation: boolean; allowedQuery?: string[] }
): Promise<{ response: Response } | { organizationId: string; actorUserId: string }> {
	const query = event.url.searchParams;
	const organizationId = query.get('organizationId');
	if (
		!organizationId ||
		!uuid.test(organizationId) ||
		!onlyKeys(query, ['organizationId', ...(options.allowedQuery ?? [])])
	)
		return { response: failure(400, 'INVALID_INPUT', 'Invalid request.') };
	if (options.mutation && event.request.headers.get('origin') !== event.url.origin)
		return { response: failure(403, 'FORBIDDEN', 'Permission denied.') };
	const denied = await requireCapability(event.request.headers, organizationId, permissionId);
	if (denied) return { response: denied };
	const principal = await resolvePrincipal(event.request.headers);
	if (!principal) return { response: failure(401, 'UNAUTHORIZED', 'Authentication required.') };
	return { organizationId, actorUserId: principal.userId };
}

/**
 * 5.4W-A (H1): webhook mutations run in a transaction that re-validates webhooks:manage for the
 * actor after locking the organization row (FOR SHARE: the services never lock it themselves).
 */
export function asWebhookManager<T>(
	ctx: { organizationId: string; actorUserId: string },
	run: (tx: AuthTransaction) => Promise<T>
): Promise<T> {
	return withActorAuthorization(
		db,
		{
			userId: ctx.actorUserId,
			organizationId: ctx.organizationId,
			permissionIds: ['webhooks:manage'],
			lock: 'share'
		},
		(tx) => run(tx)
	);
}

/** Strict small JSON object body (application/json, ≤ 8 KB). null on any violation. */
export async function readWebhookJson(request: Request): Promise<Record<string, unknown> | null> {
	if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	const decoder = new TextDecoder();
	let text = '';
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > MAX_BODY_BYTES) {
				await reader.cancel();
				return null;
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	try {
		const body: unknown = JSON.parse(text);
		return body && typeof body === 'object' && !Array.isArray(body)
			? (body as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Stable client messages; never SQL, stacks, secrets or key material. */
export function webhookFailure(error: unknown): Response {
	const oversized = resultLimitFailure(error);
	if (oversized) return oversized;
	const revoked = actorAuthorizationFailure(error);
	if (revoked) return revoked;
	if (error instanceof WebhookServiceError) {
		switch (error.code) {
			case 'INVALID_INPUT':
				return failure(400, 'INVALID_INPUT', 'Invalid request.');
			case 'INVALID_TARGET':
				return failure(
					400,
					'INVALID_TARGET',
					'Target URL must be an https URL without credentials or fragment.'
				);
			case 'SSRF_BLOCKED':
				return failure(400, 'TARGET_NOT_ALLOWED', 'Target URL is not allowed.');
			case 'WEBHOOK_NOT_FOUND':
				return failure(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
			case 'CONFIGURATION_ERROR':
				return failure(503, 'WEBHOOKS_NOT_CONFIGURED', 'Webhook signing is not configured.');
			case 'WEBHOOK_LIMIT_REACHED':
				return failure(409, 'WEBHOOK_LIMIT_REACHED', 'Active webhook limit reached.');
		}
	}
	logUnexpectedError(error);
	return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
}

const noStore = { 'Cache-Control': 'private, no-store' };
export const noContent = () => new Response(null, { status: 204, headers: noStore });
