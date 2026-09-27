import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';

/**
 * Webhook signing secrets and HMAC (5.4V-B).
 *
 * Storage: random 32-byte secrets, shown once, stored only as AES-256-GCM ciphertext under the
 * application key WEBHOOK_SECRET_ENCRYPTION_KEY (32 bytes, base64 or hex). The associated data
 * binds each ciphertext to its (subscriptionId, version), so rows cannot be swapped.
 *
 * Signature: HMAC-SHA256(secret, `${timestamp}.${rawBody}`), header `v1=<lowercase hex>`,
 * timestamp in unix seconds.
 */

export class WebhookConfigurationError extends Error {
	constructor() {
		super('CONFIGURATION_ERROR');
		this.name = 'WebhookConfigurationError';
	}
}

export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** New random signing secret (32 bytes, base64url), e.g. `whsec_…`. */
export function generateWebhookSecret(): string {
	return WEBHOOK_SECRET_PREFIX + randomBytes(32).toString('base64url');
}

/**
 * Parses the application encryption key: exactly 32 bytes as 64 hex chars or base64.
 * Missing/invalid -> WebhookConfigurationError (never a hardcoded fallback).
 */
export function parseWebhookEncryptionKey(raw: unknown): Buffer {
	if (typeof raw !== 'string' || !raw.trim()) throw new WebhookConfigurationError();
	const value = raw.trim();
	const key = /^[0-9a-f]{64}$/i.test(value)
		? Buffer.from(value, 'hex')
		: /^[A-Za-z0-9+/_-]+={0,2}$/.test(value)
			? Buffer.from(value, 'base64')
			: null;
	if (!key || key.length !== 32) throw new WebhookConfigurationError();
	return key;
}

/** Key from the environment (read on every call; nothing cached or logged). */
export function webhookEncryptionKeyFromEnv(): Buffer {
	return parseWebhookEncryptionKey(
		env.WEBHOOK_SECRET_ENCRYPTION_KEY || process.env.WEBHOOK_SECRET_ENCRYPTION_KEY
	);
}

export interface EncryptedWebhookSecret {
	ciphertext: string;
	iv: string;
	authTag: string;
}

const aad = (subscriptionId: string, version: number) =>
	Buffer.from(`soporteflow-webhook:${subscriptionId}:${version}`, 'utf8');

export function encryptWebhookSecret(
	key: Buffer,
	secret: string,
	binding: { subscriptionId: string; version: number }
): EncryptedWebhookSecret {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(aad(binding.subscriptionId, binding.version));
	const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
	return {
		ciphertext: ciphertext.toString('base64'),
		iv: iv.toString('base64'),
		authTag: cipher.getAuthTag().toString('base64')
	};
}

/** Throws WebhookConfigurationError on a wrong key or tampered data (no details exposed). */
export function decryptWebhookSecret(
	key: Buffer,
	stored: EncryptedWebhookSecret,
	binding: { subscriptionId: string; version: number }
): string {
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
		decipher.setAAD(aad(binding.subscriptionId, binding.version));
		decipher.setAuthTag(Buffer.from(stored.authTag, 'base64'));
		return Buffer.concat([
			decipher.update(Buffer.from(stored.ciphertext, 'base64')),
			decipher.final()
		]).toString('utf8');
	} catch {
		throw new WebhookConfigurationError();
	}
}

/** `v1=<hex>` of HMAC-SHA256(secret, `${timestamp}.${body}`). */
export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
	if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('timestamp');
	return 'v1=' + createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}
