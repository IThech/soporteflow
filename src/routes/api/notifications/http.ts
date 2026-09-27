import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import * as service from '$lib/server/services/notifications';
import { failure, success, onlyKeys, uuid } from '../roles/http';
type Action = 'list' | 'get' | 'mark' | 'readAll' | 'delete' | 'clear' | 'count';
export async function handle(event: RequestEvent, action: Action): Promise<Response> {
	const query = event.url.searchParams;
	const allowed =
		action === 'list'
			? ['organizationId', 'status', 'limit', 'cursor']
			: action === 'clear'
				? ['organizationId', 'scope']
				: ['organizationId'];
	const organizationId = query.get('organizationId');
	if (!onlyKeys(query, allowed) || !organizationId || !uuid.test(organizationId))
		return failure(400, 'INVALID_INPUT', 'Invalid request.');
	const id = event.params.id;
	if (['get', 'mark', 'delete'].includes(action) && (!id || !uuid.test(id)))
		return failure(400, 'INVALID_INPUT', 'Invalid request.');
	if (action === 'list') {
		if (query.has('status') && !['read', 'unread'].includes(query.get('status')!))
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		if (query.has('limit') && !/^(?:[1-9]\d?|100)$/.test(query.get('limit')!))
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
	}
	if (action === 'clear' && !['read', 'all'].includes(query.get('scope') ?? ''))
		return failure(400, 'INVALID_INPUT', 'Explicit scope required.');
	if (
		['mark', 'readAll', 'delete', 'clear'].includes(action) &&
		event.request.headers.get('origin') !== event.url.origin
	)
		return failure(403, 'FORBIDDEN', 'Permission denied.');
	if ((action === 'delete' || action === 'clear') && event.request.body !== null)
		return failure(400, 'INVALID_INPUT', 'Request body is not allowed.');
	try {
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		const context = { organizationId, recipientUserId: principal.userId };
		if (action === 'list')
			return success(
				await service.listNotifications(db, context, {
					status: (query.get('status') as 'read' | 'unread' | undefined) ?? undefined,
					limit: query.has('limit') ? Number(query.get('limit')) : undefined,
					cursor: query.get('cursor') ?? undefined
				})
			);
		if (action === 'get')
			return success({ notification: await service.getNotification(db, context, id!) });
		if (action === 'count')
			return success({ unreadCount: await service.countUnreadNotifications(db, context) });
		if (action === 'mark' || action === 'readAll') {
			if (!/^application\/json\s*(;|$)/i.test(event.request.headers.get('content-type') ?? ''))
				return failure(400, 'INVALID_INPUT', 'Invalid request.');
			const reader = event.request.body?.getReader();
			if (!reader) return failure(400, 'INVALID_INPUT', 'Invalid request.');
			let text = '',
				size = 0;
			const decoder = new TextDecoder();
			try {
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					size += chunk.value.length;
					if (size > 256) {
						await reader.cancel();
						return failure(400, 'INVALID_INPUT', 'Invalid request.');
					}
					text += decoder.decode(chunk.value, { stream: true });
				}
				text += decoder.decode();
			} finally {
				reader.releaseLock();
			}
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				return failure(400, 'INVALID_INPUT', 'Invalid request.');
			}
			if (!body || typeof body !== 'object' || Array.isArray(body))
				return failure(400, 'INVALID_INPUT', 'Invalid request.');
			const keys = Object.keys(body);
			if (action === 'readAll') {
				if (keys.length) return failure(400, 'INVALID_INPUT', 'Invalid request.');
				await service.markAllNotificationsRead(db, context);
			} else {
				const read = (body as Record<string, unknown>).read;
				if (keys.length !== 1 || keys[0] !== 'read' || typeof read !== 'boolean')
					return failure(400, 'INVALID_INPUT', 'Invalid request.');
				return success({
					notification: await (
						read ? service.markNotificationRead : service.markNotificationUnread
					)(db, context, id!)
				});
			}
		} else if (action === 'delete') await service.deleteNotification(db, context, id!);
		else if (action === 'clear')
			await service.clearNotifications(db, context, query.get('scope') as 'read' | 'all');
		return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
	} catch (error) {
		if (error instanceof service.NotificationServiceError) {
			if (error.code === 'INVALID_INPUT') return failure(400, error.code, 'Invalid request.');
			if (error.code === 'NOTIFICATION_NOT_FOUND')
				return failure(404, error.code, 'Notification not found.');
			if (error.code === 'FORBIDDEN') return failure(403, error.code, 'Permission denied.');
		}
		return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
	}
}
