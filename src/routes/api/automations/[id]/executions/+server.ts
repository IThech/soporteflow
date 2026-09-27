import type { RequestHandler } from '@sveltejs/kit';
import { handle } from '../../http';
export const GET: RequestHandler = (event) => handle(event, 'executions');
