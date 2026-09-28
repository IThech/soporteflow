import { building, dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { validateServerEnvironment } from '$lib/server/config/env';
import { observeRequest } from '$lib/server/logging/http';
import { logError, logger } from '$lib/server/logging/logger';
import { webSecurityObserver } from '$lib/server/logging/web-observer';
import { limitApiAbuse } from '$lib/server/security/api-abuse';
import { handleWebRequest } from '$lib/server/security/web';

/** 5.4W-E: fail fast on invalid configuration. Errors name variables, never values. */
export const init: ServerInit = () => {
	if (building) return;
	try {
		const summary = validateServerEnvironment({ ...process.env, ...env }, { development: dev });
		logger.info('config.validated', { ...summary, warnings: summary.warnings.length });
		for (const warning of summary.warnings) logger.warn('config.warning', { ...warning });
	} catch (error) {
		logError('config.invalid', error);
		throw error;
	}
};

export const handle: Handle = ({ event, resolve }) =>
	observeRequest(event, () =>
		handleWebRequest(event, resolve, {
			origin: env.BETTER_AUTH_URL,
			development: dev,
			beforeResolve: limitApiAbuse,
			observer: webSecurityObserver
		})
	);

/** Public message stays generic; the redacted stack is logged server-side with the requestId. */
export const handleError: HandleServerError = ({ error, status }) => {
	if (status >= 500) logError('http.unhandled_error', error, { status });
	return { message: 'Internal server error.' };
};
