import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * Invitation token encryption at rest (5.4X-C, option 1).
 *
 * The invitation email needs the raw token to build its link, but the token must never be stored
 * in plaintext. While a delivery is in flight the token is kept as AES-256-GCM ciphertext:
 * - key: INVITATION_TOKEN_ENCRYPTION_KEY — exactly 32 bytes (64 hex chars or base64), independent
 *   of WEBHOOK_SECRET_ENCRYPTION_KEY (checked at startup), no fallback, never logged;
 * - IV: 12 random bytes per encryption (never reused for a key);
 * - auth tag: 16 bytes, verified on decryption;
 * - AAD: `soporteflow-invitation-token:v1:<invitationId>:<deliveryId>` — a ciphertext cannot be
 *   moved to another invitation or delivery row.
 * Any failure (wrong key, tampering, wrong binding, missing key) surfaces as
 * InvitationTokenConfigurationError without details.
 */

export class InvitationTokenConfigurationError extends Error {
	constructor() {
		super('INVITATION_TOKEN_CONFIGURATION_ERROR');
		this.name = 'InvitationTokenConfigurationError';
	}
}

export interface EncryptedInvitationToken {
	ciphertext: string;
	iv: string;
	authTag: string;
}

export interface InvitationTokenBinding {
	invitationId: string;
	deliveryId: string;
}

/** Exactly 32 bytes as 64 hex characters or base64/base64url; anything else is rejected. */
export function parseInvitationTokenKey(raw: unknown): Buffer {
	if (typeof raw !== 'string' || !raw.trim()) throw new InvitationTokenConfigurationError();
	const value = raw.trim();
	const key = /^[0-9a-f]{64}$/i.test(value)
		? Buffer.from(value, 'hex')
		: /^[A-Za-z0-9+/_-]+={0,2}$/.test(value)
			? Buffer.from(value, 'base64')
			: null;
	if (!key || key.length !== 32) throw new InvitationTokenConfigurationError();
	return key;
}

/** Key from the environment, read on every call (nothing cached or logged). */
export function invitationTokenKeyFromEnv(): Buffer {
	return parseInvitationTokenKey(
		env.INVITATION_TOKEN_ENCRYPTION_KEY || process.env.INVITATION_TOKEN_ENCRYPTION_KEY
	);
}

const aad = (binding: InvitationTokenBinding) =>
	Buffer.from(
		`soporteflow-invitation-token:v1:${binding.invitationId}:${binding.deliveryId}`,
		'utf8'
	);

export function encryptInvitationToken(
	key: Buffer,
	token: string,
	binding: InvitationTokenBinding
): EncryptedInvitationToken {
	if (key.length !== 32) throw new InvitationTokenConfigurationError();
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(aad(binding));
	const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
	return {
		ciphertext: ciphertext.toString('base64'),
		iv: iv.toString('base64'),
		authTag: cipher.getAuthTag().toString('base64')
	};
}

export function decryptInvitationToken(
	key: Buffer,
	stored: EncryptedInvitationToken,
	binding: InvitationTokenBinding
): string {
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'), {
			authTagLength: 16
		});
		decipher.setAAD(aad(binding));
		decipher.setAuthTag(Buffer.from(stored.authTag, 'base64'));
		return Buffer.concat([
			decipher.update(Buffer.from(stored.ciphertext, 'base64')),
			decipher.final()
		]).toString('utf8');
	} catch {
		throw new InvitationTokenConfigurationError();
	}
}
