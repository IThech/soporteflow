import {
	ApiError,
	apiErrorFromResponse,
	invalidPayloadError,
	isAbortError,
	networkApiError
} from './errors.ts';
import type { IncidentAttachment } from '../attachments.ts';
export function attachmentUrl(org: string, incident: string, file?: string): string {
	return `/api/incidents/${encodeURIComponent(incident)}/attachments${file ? `/${encodeURIComponent(file)}/download` : ''}?organizationId=${encodeURIComponent(org)}`;
}
function parseItem(v: unknown): IncidentAttachment {
	if (!v || typeof v !== 'object') throw invalidPayloadError(200);
	const r = v as Record<string, unknown>;
	if (
		typeof r.id !== 'string' ||
		!/^[0-9a-f-]{36}$/i.test(r.id) ||
		typeof r.originalName !== 'string' ||
		typeof r.mimeType !== 'string' ||
		!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(r.mimeType) ||
		typeof r.size !== 'number' ||
		!Number.isInteger(r.size) ||
		r.size < 1 ||
		r.size > 5242880 ||
		typeof r.createdAt !== 'string' ||
		!Number.isFinite(Date.parse(r.createdAt))
	)
		throw invalidPayloadError(200);
	return {
		id: r.id,
		originalName: r.originalName,
		mimeType: r.mimeType,
		size: r.size,
		createdAt: r.createdAt
	};
}
async function response(url: string, init: RequestInit) {
	let r: Response;
	try {
		r = await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store' });
	} catch (e) {
		if (isAbortError(e)) throw e;
		throw networkApiError();
	}
	if (!r.ok) throw await apiErrorFromResponse(r);
	return r;
}
export async function listIncidentAttachments(org: string, incident: string, signal?: AbortSignal) {
	const r = await response(attachmentUrl(org, incident), { method: 'GET', signal });
	try {
		const body = await r.json();
		if (!body || !Array.isArray(body.items) || body.items.length > 5)
			throw invalidPayloadError(r.status);
		return body.items.map(parseItem) as IncidentAttachment[];
	} catch (e) {
		if (e instanceof ApiError) throw e;
		throw invalidPayloadError(r.status);
	}
}
export async function uploadIncidentAttachment(
	org: string,
	incident: string,
	file: File,
	signal?: AbortSignal
) {
	const body = new FormData();
	body.append('file', file);
	const r = await response(attachmentUrl(org, incident), { method: 'POST', body, signal });
	try {
		return parseItem((await r.json()).item);
	} catch (e) {
		if (e instanceof ApiError) throw e;
		throw invalidPayloadError(r.status);
	}
}
export async function downloadIncidentAttachment(
	org: string,
	incident: string,
	id: string,
	signal?: AbortSignal
) {
	return (await response(attachmentUrl(org, incident, id), { method: 'GET', signal })).blob();
}
