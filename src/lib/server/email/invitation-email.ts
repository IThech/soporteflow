/**
 * Invitation email delivery (5.4S-C). Server-only abstraction: the invitation service hands the
 * raw invitation token to the configured sender and never persists or returns it.
 *
 * No real provider is integrated yet. The default sender is UnconfiguredInvitationEmailSender,
 * which FAILS explicitly (never pretends a delivery succeeded): the invitation stays pending and
 * can be resent once a provider is configured. MemoryInvitationEmailSender is for tests only.
 */

export interface InvitationEmailMessage {
	/** Normalized recipient address. */
	readonly email: string;
	readonly organizationName: string;
	readonly roleName: string;
	/** Raw invitation token (only ever exists in memory; the database holds its SHA-256). */
	readonly token: string;
	readonly expiresAt: Date;
}

export interface InvitationEmailSender {
	sendInvitation(message: InvitationEmailMessage): Promise<void>;
}

/** Delivery failure. Its message is internal and never forwarded to HTTP clients. */
export class EmailDeliveryError extends Error {
	constructor(message = 'Invitation email delivery failed') {
		super(message);
		this.name = 'EmailDeliveryError';
	}
}

/** Default sender while no email provider is configured: always fails explicitly. */
export class UnconfiguredInvitationEmailSender implements InvitationEmailSender {
	async sendInvitation(): Promise<void> {
		throw new EmailDeliveryError('Invitation email delivery is not configured');
	}
}

/** In-memory sender for tests: captures every message; can be told to fail. No network. */
export class MemoryInvitationEmailSender implements InvitationEmailSender {
	readonly sent: InvitationEmailMessage[] = [];
	failing = false;

	async sendInvitation(message: InvitationEmailMessage): Promise<void> {
		if (this.failing) throw new EmailDeliveryError('Simulated delivery failure');
		this.sent.push({ ...message });
	}

	/** Last message sent to this address, if any. */
	lastTo(email: string): InvitationEmailMessage | undefined {
		return this.sent.filter((message) => message.email === email).at(-1);
	}

	reset(): void {
		this.sent.length = 0;
		this.failing = false;
	}
}

let configuredSender: InvitationEmailSender = new UnconfiguredInvitationEmailSender();

/** Sender used by the invitation endpoints. */
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
