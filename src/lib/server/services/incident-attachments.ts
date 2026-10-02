import { and, asc, eq, or, sql } from 'drizzle-orm';
import { incidentAttachments, incidents } from '../db/schema';
import type { IncidentAccess, IncidentDatabase } from './incidents';
import type { AttachmentStorage } from '../attachments/storage';
import { AttachmentError } from '../attachments/validation';
import type { IncidentAttachment } from '../../attachments';
export interface AttachmentContext {
	organizationId: string;
	incidentId: string;
	access: IncidentAccess;
}
/** Filter tenant AND scope in SQL before obtaining any incident data. */
export async function lockAttachmentIncident(
	tx: IncidentDatabase,
	c: AttachmentContext,
	write = false
) {
	const scope = c.access.viewAll
		? undefined
		: or(
				c.access.assignedToUserId
					? eq(incidents.assignedToUserId, c.access.assignedToUserId)
					: sql`false`,
				c.access.clientUserId ? eq(incidents.clientUserId, c.access.clientUserId) : sql`false`
			);
	const [incident] = await tx
		.select({ id: incidents.id, status: incidents.status })
		.from(incidents)
		.where(
			and(eq(incidents.id, c.incidentId), eq(incidents.organizationId, c.organizationId), scope)
		)
		.for(write ? 'update' : 'share');
	if (!incident) throw new AttachmentError(404, 'NOT_FOUND');
	if (write && incident.status === 'closed') throw new AttachmentError(409, 'INCIDENT_CLOSED');
	return incident;
}
const condition = (c: AttachmentContext) =>
	and(
		eq(incidentAttachments.organizationId, c.organizationId),
		eq(incidentAttachments.incidentId, c.incidentId)
	);
export function attachmentDto(row: typeof incidentAttachments.$inferSelect): IncidentAttachment {
	return {
		id: row.id,
		originalName: row.originalName,
		mimeType: row.mimeType,
		size: row.size,
		createdAt: row.createdAt.toISOString()
	};
}
export async function listAttachments(tx: IncidentDatabase, c: AttachmentContext) {
	await lockAttachmentIncident(tx, c);
	return (
		await tx
			.select()
			.from(incidentAttachments)
			.where(condition(c))
			.orderBy(asc(incidentAttachments.createdAt), asc(incidentAttachments.id))
			.limit(5)
	).map(attachmentDto);
}
/** Caller owns the transaction AND revalidates actor/add_comment inside it. */
export async function insertAttachment(
	tx: IncidentDatabase,
	c: AttachmentContext,
	row: typeof incidentAttachments.$inferInsert,
	bytes: Uint8Array,
	storage: AttachmentStorage
) {
	await lockAttachmentIncident(tx, c, true);
	const [count] = await tx
		.select({ value: sql<number>`count(*)::int` })
		.from(incidentAttachments)
		.where(condition(c));
	if (count.value >= 5) throw new AttachmentError(409, 'ATTACHMENT_LIMIT');
	await storage.put(row.storageKey, bytes);
	const [saved] = await tx.insert(incidentAttachments).values(row).returning();
	return attachmentDto(saved);
}
export async function downloadAttachment(
	tx: IncidentDatabase,
	c: AttachmentContext,
	id: string,
	storage: AttachmentStorage
) {
	await lockAttachmentIncident(tx, c);
	const [row] = await tx
		.select()
		.from(incidentAttachments)
		.where(and(condition(c), eq(incidentAttachments.id, id)));
	if (!row) throw new AttachmentError(404, 'NOT_FOUND');
	const bytes = await storage.read(row.storageKey);
	if (bytes.length !== row.size) throw new AttachmentError(503, 'STORAGE_FILE_UNAVAILABLE');
	return { item: attachmentDto(row), bytes };
}
