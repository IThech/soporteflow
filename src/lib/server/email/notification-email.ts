/**
 * Notification email delivery (5.4U-D). Server-only abstraction used exclusively by the
 * notification delivery processor, never inside a domain transaction.
 *
 * Same pattern as invitation-email.ts: no real provider is integrated yet. The default sender is
 * UnconfiguredNotificationEmailSender, which fails explicitly with PROVIDER_NOT_CONFIGURED (never
 * pretends a delivery succeeded). MemoryNotificationEmailSender is for tests only.
 *
 * Messages are text/plain only: subject = notification title, body = notification message. Both
 * are fixed server-side texts (notification-producer); the address comes from the database.
 */

export interface NotificationEmailMessage {
	/** Recipient address (the user's sign-in email from auth_users, validated by the processor). */
	readonly to: string;
	/** Single line (CR/LF removed by the processor). */
	readonly subject: string;
	/** Plain text body. No HTML is ever produced. */
	readonly text: string;
}

export interface NotificationEmailResult {
	/** Provider id, if any. Stored truncated; never the raw provider response. */
	readonly providerMessageId?: string;
}

export interface NotificationEmailSender {
	sendNotification(message: NotificationEmailMessage): Promise<NotificationEmailResult | void>;
}

/** Safe, persisted failure codes an adapter may report. */
export type NotificationEmailErrorCode =
	| 'PROVIDER_NOT_CONFIGURED'
	| 'NETWORK_ERROR'
	| 'RATE_LIMITED'
	| 'RECIPIENT_INVALID'
	| 'PROVIDER_ERROR';

/** Transient codes are retried with backoff; the rest fail the delivery permanently. */
export const TRANSIENT_EMAIL_ERROR_CODES: ReadonlySet<NotificationEmailErrorCode> = new Set([
	'NETWORK_ERROR',
	'RATE_LIMITED',
	'PROVIDER_ERROR'
]);

/**
 * Adapter failure. Its message is internal and never persisted: only `code` is. Adapters map
 * provider responses to a code (5xx/timeouts -> PROVIDER_ERROR/NETWORK_ERROR, 429 -> RATE_LIMITED,
 * rejected address -> RECIPIENT_INVALID). Any other thrown value is treated as PROVIDER_ERROR.
 */
export class NotificationEmailError extends Error {
	constructor(
		readonly code: NotificationEmailErrorCode,
		message: string = code
	) {
		super(message);
		this.name = 'NotificationEmailError';
	}
}

/** Default sender while no email provider is configured: always fails explicitly. */
export class UnconfiguredNotificationEmailSender implements NotificationEmailSender {
	async sendNotification(): Promise<void> {
		throw new NotificationEmailError('PROVIDER_NOT_CONFIGURED');
	}
}

/** In-memory sender for tests: captures every message; failures can be scripted. No network. */
export class MemoryNotificationEmailSender implements NotificationEmailSender {
	readonly sent: NotificationEmailMessage[] = [];
	/** Failures consumed one per call (in order) before sending succeeds again. */
	readonly failures: unknown[] = [];

	async sendNotification(message: NotificationEmailMessage): Promise<NotificationEmailResult> {
		if (this.failures.length > 0) throw this.failures.shift();
		this.sent.push({ ...message });
		return { providerMessageId: `memory-${this.sent.length}` };
	}

	reset(): void {
		this.sent.length = 0;
		this.failures.length = 0;
	}
}

let configuredSender: NotificationEmailSender = new UnconfiguredNotificationEmailSender();

/** Sender used by the delivery processor when none is injected. */
export function getNotificationEmailSender(): NotificationEmailSender {
	return configuredSender;
}

/** Installs the process-wide sender; undefined restores the unconfigured (failing) sender. */
export function setNotificationEmailSender(sender: NotificationEmailSender | undefined): void {
	configuredSender = sender ?? new UnconfiguredNotificationEmailSender();
}
