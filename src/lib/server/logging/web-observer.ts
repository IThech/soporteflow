import type { WebSecurityObserver } from '../security/web';
import { logError, throttled } from './logger';

/**
 * 5.4W-E: structured-logging implementation of the W-C observer. Rejections are throttled per
 * reason (server constant), so a flood of malformed requests cannot flood the log.
 */
export const webSecurityObserver: WebSecurityObserver = {
	rejected(rejection) {
		throttled(rejection.severity, 'security.request_rejected', rejection.reason, { ...rejection });
	},
	unhandled(error) {
		logError('http.unhandled_error', error);
	}
};
