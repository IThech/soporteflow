import { isTrivialSecret } from '../auth/config';
import { parseWebhookEncryptionKey } from '../webhooks/secrets';
import { describeDatabaseUrl } from '../logging/redact';

/**
 * Central server environment validation (5.4W-E), run once at startup (hooks.server.ts `init`).
 *
 * Contract:
 * - fails fast with ServerConfigurationError listing VARIABLE NAMES and the problem, never a
 *   value (not even a prefix);
 * - production (`development === false`, i.e. a built server) is strict: HTTPS public origin,
 *   strong non-placeholder secrets, no development/test NODE_ENV;
 * - development/test is practical: nothing is required unless the feature is enabled, and
 *   loopback HTTP is allowed. Production never takes a development bypass.
 *
 * Variables actually used by the application (inventory in docs/operational-security-5.4w-e.md):
 * BETTER_AUTH_ENABLED, BETTER_AUTH_SECRET, BETTER_AUTH_URL, DATABASE_URL,
 * WEBHOOK_SECRET_ENCRYPTION_KEY, LOG_LEVEL, NODE_ENV. There is no email provider credential yet.
 */

export interface ConfigIssue {
	readonly variable: string;
	readonly problem: string;
}

export class ServerConfigurationError extends Error {
	constructor(readonly issues: readonly ConfigIssue[]) {
		super(
			'Invalid server configuration: ' +
				issues.map((issue) => `${issue.variable} ${issue.problem}`).join('; ')
		);
		this.name = 'ServerConfigurationError';
	}
}

export interface ServerConfigSummary {
	mode: 'production' | 'development';
	auth: 'enabled' | 'disabled';
	publicOrigin: string | null;
	/** Protocol/host/port/database only: never credentials or query. */
	database: string;
	webhookSigning: 'configured' | 'unset';
	logLevel: string;
	warnings: ConfigIssue[];
}

const LOG_LEVEL_VALUES = ['debug', 'info', 'warn', 'error', 'silent'];
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
/** Values that are fine in a lab or a test but must never reach a production build. */
const NON_PRODUCTION_SECRET =
	/(change[-_ ]?me|example|sample|dummy|placeholder|synthetic|test|lab[-_]|dev[-_]?secret|localhost|your[-_ ]?(secret|key))/i;
export const MIN_AUTH_SECRET_LENGTH = 32;

type Env = Record<string, string | undefined>;
const present = (value: string | undefined): value is string =>
	typeof value === 'string' && value.trim() !== '';

export function validateServerEnvironment(
	env: Env,
	options: { development: boolean }
): ServerConfigSummary {
	const production = !options.development;
	const issues: ConfigIssue[] = [];
	const warnings: ConfigIssue[] = [];
	const issue = (variable: string, problem: string) => issues.push({ variable, problem });

	// --- NODE_ENV / LOG_LEVEL (non-secret) ---------------------------------------------------
	const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
	if (production && (nodeEnv === 'development' || nodeEnv === 'test'))
		issue('NODE_ENV', 'must not be development/test in a production build');
	const logLevel = env.LOG_LEVEL?.trim().toLowerCase() || 'info';
	if (!LOG_LEVEL_VALUES.includes(logLevel))
		issue('LOG_LEVEL', `must be one of ${LOG_LEVEL_VALUES.join(', ')}`);

	// --- Better Auth -------------------------------------------------------------------------
	const flag = env.BETTER_AUTH_ENABLED;
	let authEnabled = false;
	if (flag === 'true') authEnabled = true;
	else if (flag !== undefined && flag !== '' && flag !== 'false')
		issue('BETTER_AUTH_ENABLED', 'must be true or false');

	if (authEnabled) {
		const secret = env.BETTER_AUTH_SECRET;
		if (!present(secret)) issue('BETTER_AUTH_SECRET', 'is missing');
		else if (secret.trim().length < MIN_AUTH_SECRET_LENGTH)
			issue('BETTER_AUTH_SECRET', `must be at least ${MIN_AUTH_SECRET_LENGTH} random characters`);
		else if (isTrivialSecret(secret)) issue('BETTER_AUTH_SECRET', 'is a trivial or default value');
		else if (production && NON_PRODUCTION_SECRET.test(secret))
			issue('BETTER_AUTH_SECRET', 'looks like a development/test value');
	}

	// The public origin also drives the W-C Origin/CSRF policy, so production always needs it.
	let publicOrigin: string | null = null;
	const rawOrigin = env.BETTER_AUTH_URL;
	if (!present(rawOrigin)) {
		if (authEnabled || production) issue('BETTER_AUTH_URL', 'is missing');
	} else {
		let url: URL | null = null;
		try {
			url = new URL(rawOrigin);
		} catch {
			issue('BETTER_AUTH_URL', 'is not a valid URL');
		}
		if (url) {
			const loopbackHttp =
				options.development && url.protocol === 'http:' && LOOPBACK.includes(url.hostname);
			if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
				issue('BETTER_AUTH_URL', 'must be an origin without credentials, path, query or fragment');
			else if (url.protocol !== 'https:' && !loopbackHttp)
				issue(
					'BETTER_AUTH_URL',
					production
						? 'must use HTTPS in production'
						: 'must use HTTPS (HTTP only for loopback in development)'
				);
			else publicOrigin = url.origin;
		}
	}

	// --- Database ------------------------------------------------------------------------------
	const databaseUrl = env.DATABASE_URL;
	if (!present(databaseUrl)) {
		if (authEnabled) issue('DATABASE_URL', 'is missing');
	} else {
		let valid: boolean;
		try {
			const url = new URL(databaseUrl);
			valid =
				['postgres:', 'postgresql:'].includes(url.protocol) &&
				!!url.hostname &&
				url.pathname.length > 1;
		} catch {
			valid = false;
		}
		if (!valid) issue('DATABASE_URL', 'is not a valid PostgreSQL URL');
	}

	// --- Webhook signing-secret encryption key (optional feature) ----------------------------
	let webhookSigning: ServerConfigSummary['webhookSigning'] = 'unset';
	const rawKey = env.WEBHOOK_SECRET_ENCRYPTION_KEY;
	if (present(rawKey)) {
		let key: Buffer | null = null;
		try {
			key = parseWebhookEncryptionKey(rawKey);
		} catch {
			issue(
				'WEBHOOK_SECRET_ENCRYPTION_KEY',
				'must be exactly 32 bytes encoded as 64 hex characters or base64'
			);
		}
		if (key) {
			if (new Set(key).size < 8)
				issue('WEBHOOK_SECRET_ENCRYPTION_KEY', 'is a trivial key (not random)');
			else webhookSigning = 'configured';
		}
	} else if (production) {
		warnings.push({
			variable: 'WEBHOOK_SECRET_ENCRYPTION_KEY',
			problem:
				'is unset: webhook creation returns 503 and deliveries retry with CONFIGURATION_ERROR'
		});
	}
	if (production && !authEnabled)
		warnings.push({
			variable: 'BETTER_AUTH_ENABLED',
			problem: 'is not true: authentication endpoints are disabled'
		});

	if (issues.length > 0) throw new ServerConfigurationError(issues);
	return {
		mode: production ? 'production' : 'development',
		auth: authEnabled ? 'enabled' : 'disabled',
		publicOrigin,
		database: describeDatabaseUrl(databaseUrl),
		webhookSigning,
		logLevel,
		warnings
	};
}
