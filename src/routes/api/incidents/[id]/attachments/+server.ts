import type { RequestHandler } from '@sveltejs/kit';
import { attachmentRequest } from '$lib/server/attachments/http';
export const GET: RequestHandler = (event) => attachmentRequest(event, 'list');
export const POST: RequestHandler = (event) => attachmentRequest(event, 'upload');
