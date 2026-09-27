import type { RequestHandler } from '@sveltejs/kit';
import { handle } from '../http';
export const GET: RequestHandler = (event) => handle(event, 'get');
export const PATCH: RequestHandler = (event) => handle(event, 'mark');
export const DELETE: RequestHandler = (event) => handle(event, 'delete');
