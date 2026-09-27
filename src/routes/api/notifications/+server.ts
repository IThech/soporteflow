import type { RequestHandler } from '@sveltejs/kit';
import { handle } from './http';
export const GET: RequestHandler = (event) => handle(event, 'list');
export const DELETE: RequestHandler = (event) => handle(event, 'clear');
