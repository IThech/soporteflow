import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { handleWebRequest } from '$lib/server/security/web';

export const handle: Handle = ({ event, resolve }) =>
	handleWebRequest(event, resolve, { origin: env.BETTER_AUTH_URL, development: dev });

export const handleError: HandleServerError = () => ({ message: 'Internal server error.' });
