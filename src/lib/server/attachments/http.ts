import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { json, type RequestEvent } from '@sveltejs/kit';
import { db } from '../db';
import { resolvePrincipal } from '../auth/principal';
import {
	withIncidentActor,
	requireReadScope,
	resolveIncidentAccess
} from '../auth/incident-access';
import type { PermissionId } from '../auth/permissions';
import { isActorAuthorizationError } from '../auth/transactional-authorization';
import {
	listAttachments,
	insertAttachment,
	downloadAttachment
} from '../services/incident-attachments';
import { AttachmentError, validateAttachment } from './validation';
import { localAttachmentStorage, type AttachmentStorage } from './storage';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
import { isDevStorageAllowed } from './environment';
export { isDevStorageAllowed };
function storage(): AttachmentStorage {
	const root = env.ATTACHMENT_DEV_ROOT || process.env.ATTACHMENT_DEV_ROOT;
	const deploymentEnv = env.DEPLOYMENT_ENV || process.env.DEPLOYMENT_ENV;
	const nodeEnv = env.NODE_ENV || process.env.NODE_ENV;
	if (
		!isDevStorageAllowed({
			DEPLOYMENT_ENV: deploymentEnv,
			NODE_ENV: nodeEnv,
			ATTACHMENT_DEV_ROOT: root
		}) ||
		!root
	)
		throw new AttachmentError(503, 'STORAGE_NOT_CONFIGURED');
	return localAttachmentStorage(root);
}
export async function attachmentRequest(
	event: RequestEvent,
	operation: 'list' | 'upload' | 'download'
) {
	let cleanup: { storage: AttachmentStorage; key: string } | null = null;
	let callbackCompleted = false;
	try {
		const organizationId = event.url.searchParams.get('organizationId');
		const incidentId = event.params.id;
		if (
			!organizationId ||
			!incidentId ||
			!uuid.test(organizationId) ||
			!uuid.test(incidentId) ||
			[...event.url.searchParams.keys()].some((k) => k !== 'organizationId') ||
			event.url.searchParams.getAll('organizationId').length !== 1 ||
			(operation === 'download' && !uuid.test(event.params.attachmentId ?? ''))
		)
			throw new AttachmentError(400, 'INVALID_INPUT');
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) throw new AttachmentError(401, 'UNAUTHORIZED');
		const access = await resolveIncidentAccess(
			event.request.headers,
			organizationId,
			principal.userId
		);
		if (!access) throw new AttachmentError(403, 'FORBIDDEN');
		// Select a held read capability, then revalidate it and the full scope inside the transaction.
		const permissionIds: PermissionId[] =
			operation === 'upload'
				? ['incidents:add_comment']
				: [
						access.viewAll
							? 'incidents:view_all'
							: access.assignedToUserId
								? 'incidents:view_own'
								: 'incidents:view_requested'
					];
		const result = await withIncidentActor(
			db,
			{
				userId: principal.userId,
				organizationId,
				permissionIds
			},
			async (tx, scope) => {
				const c = { organizationId, incidentId, access: requireReadScope(scope) };
				if (operation === 'list') return json({ items: await listAttachments(tx, c) }, { headers });
				const files = storage();
				if (operation === 'download') {
					const { item, bytes } = await downloadAttachment(
						tx,
						c,
						event.params.attachmentId!,
						files
					);
					return new Response(new Uint8Array(bytes), {
						headers: {
							...headers,
							'Content-Type': item.mimeType,
							'Content-Length': String(item.size),
							'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(item.originalName).replace(/['()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())}`
						}
					});
				}
				let form: FormData;
				try {
					form = await event.request.formData();
				} catch {
					throw new AttachmentError(400, 'INVALID_FILE');
				}
				const entries = [...form.entries()];
				if (entries.length !== 1 || entries[0][0] !== 'file' || typeof entries[0][1] === 'string')
					throw new AttachmentError(400, 'INVALID_FILE');
				const file = entries[0][1];
				const bytes = new Uint8Array(await file.arrayBuffer());
				validateAttachment(file, bytes);
				const key = randomUUID();
				cleanup = { storage: files, key };
				const item = await insertAttachment(
					tx,
					c,
					{
						organizationId,
						incidentId,
						actorId: principal.userId,
						originalName: file.name,
						storageKey: key,
						mimeType: file.type,
						size: file.size
					},
					bytes,
					files
				);
				callbackCompleted = true;
				return json({ item }, { status: 201, headers });
			}
		);
		return result;
	} catch (error) {
		// A commit failure can have an unknown outcome: never delete a possibly committed file.
		if (callbackCompleted && operation === 'upload') {
			return json(
				{ error: { code: 'UPLOAD_OUTCOME_UNKNOWN', message: 'No se pudo confirmar la subida.' } },
				{ status: 503, headers }
			);
		}
		if (cleanup && !callbackCompleted) {
			const failed = cleanup as { storage: AttachmentStorage; key: string };
			await failed.storage.removeFailedUpload(failed.key).catch(() => {});
		}
		const status = isActorAuthorizationError(error)
			? 403
			: error instanceof AttachmentError
				? error.status
				: 500;
		const code = isActorAuthorizationError(error)
			? 'FORBIDDEN'
			: error instanceof AttachmentError
				? error.code
				: 'INTERNAL_ERROR';
		return json(
			{
				error: {
					code,
					message:
						(
							{
								INVALID_FILE: 'El nombre, tamaño o tipo del archivo no es válido.',
								INVALID_FILE_CONTENT:
									'El contenido del archivo no corresponde a un formato permitido.',
								PAYLOAD_TOO_LARGE: 'El archivo supera el máximo de 5 MB.',
								ATTACHMENT_LIMIT: 'La incidencia ya tiene el máximo de 5 adjuntos.',
								INCIDENT_CLOSED: 'No se pueden añadir adjuntos a una incidencia cerrada.'
							} as Record<string, string>
						)[code] ?? 'No se pudo completar la operación de adjuntos.'
				}
			},
			{ status, headers }
		);
	}
}
