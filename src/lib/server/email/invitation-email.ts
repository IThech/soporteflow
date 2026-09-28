import type { NotificationEmailErrorCode } from './notification-email';

/**
 * Invitation email delivery (5.4S-C; durable outbox since 5.4X-C). Server-only abstraction used
 * by the invitation delivery worker (services/invitation-deliveries.ts), never inside a request
 * or a domain transaction. The worker decrypts the one-time token only in memory, right before
 * calling the sender; senders must never log or persist it.
 *
 * No real provider is integrated yet. The default sender is UnconfiguredInvitationEmailSender,
 * which FAILS explicitly with PROVIDER_NOT_CONFIGURED (never pretends a delivery succeeded): the
 * delivery fails permanently (ciphertext neutralized), the invitation stays pending and an
 * explicit resend issues a new token once a provider is configured.
 * MemoryInvitationEmailSender is for tests only.
 */

export interface InvitationEmailMessage {
	/** Normalized recipient address. */
	readonly email: string;
	readonly organizationName: string;
	readonly roleName: string;
	/** Raw invitation token (only ever in memory; the database holds its SHA-256 + ciphertext). */
	readonly token: string;
	readonly expiresAt: Date;
}

export interface InvitationEmailSender {
	sendInvitation(message: InvitationEmailMessage): Promise<void>;
}

/**
 * Adapter failure with a safe code (same vocabulary as notification email). Only the code is
 * persisted or logged; the message never is.
 */
export class InvitationEmailError extends Error {
	constructor(
		readonly code: NotificationEmailErrorCode,
		message: string = code
	) {
		super(message);
		this.name = 'InvitationEmailError';
	}
}

/** Generic delivery failure (classified as a transient PROVIDER_ERROR). Message never exposed. */
export class EmailDeliveryError extends Error {
	constructor(message = 'Invitation email delivery failed') {
		super(message);
		this.name = 'EmailDeliveryError';
	}
}

/** Default sender while no email provider is configured: always fails explicitly. */
export class UnconfiguredInvitationEmailSender implements InvitationEmailSender {
	async sendInvitation(): Promise<void> {
		throw new InvitationEmailError('PROVIDER_NOT_CONFIGURED');
	}
}

/** In-memory sender for tests: captures every message; failures can be scripted. No network. */
export class MemoryInvitationEmailSender implements InvitationEmailSender {
	readonly sent: InvitationEmailMessage[] = [];
	failing = false;
	/** Scripted failures, consumed one per call (in order) before the failing flag applies. */
	readonly failures: unknown[] = [];

	async sendInvitation(message: InvitationEmailMessage): Promise<void> {
		if (this.failures.length > 0) throw this.failures.shift();
		if (this.failing) throw new EmailDeliveryError('Simulated delivery failure');
		this.sent.push({ ...message });
	}

	/** Last message sent to this address, if any. */
	lastTo(email: string): InvitationEmailMessage | undefined {
		return this.sent.filter((message) => message.email === email).at(-1);
	}

	reset(): void {
		this.sent.length = 0;
		this.failures.length = 0;
		this.failing = false;
	}
}

let configuredSender: InvitationEmailSender = new UnconfiguredInvitationEmailSender();

/** Sender used by the invitation delivery worker when none is injected. */
export function getInvitationEmailSender(): InvitationEmailSender {
	return configuredSender;
}

/**
 * Installs the process-wide invitation sender (server startup wiring or tests). Passing
 * undefined restores the unconfigured (failing) sender.
 */
export function setInvitationEmailSender(sender: InvitationEmailSender | undefined): void {
	configuredSender = sender ?? new UnconfiguredInvitationEmailSender();
}
