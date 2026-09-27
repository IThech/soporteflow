import type { RequestHandler } from '@sveltejs/kit';
import { handle } from '../http';
export const POST: RequestHandler = (event) => handle(event, 'readAll');
