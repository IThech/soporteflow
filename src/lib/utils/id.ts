/**
 * Centralized unique identifier generator compatible with all execution contexts.
 *
 * Context Compatibility:
 * 1. Secure Contexts (HTTPS, localhost):
 *    Uses the browser / Node.js native `crypto.randomUUID()` when available.
 * 2. Insecure Contexts (e.g. testing over local network IP like http://192.168.x.x:5173):
 *    The Web Cryptography specification restricts `crypto.randomUUID` to Secure Contexts,
 *    causing it to be undefined on mobile devices or remote browsers accessing plain HTTP.
 *    In those environments, we fall back safely to:
 *    a) `crypto.getRandomValues()` to construct a cryptographically-sound RFC 4122 v4 UUID.
 *    b) A high-entropy pseudo-random generator combining Date.now(), performance.now(),
 *       and Math.random() formatted as a compliant UUID v4 string.
 */
export function generateId(): string {
	// 1. Native crypto.randomUUID if available
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}

	// 2. crypto.getRandomValues fallback if available in insecure contexts
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		try {
			const bytes = new Uint8Array(16);
			crypto.getRandomValues(bytes);
			// Set version to 0100 (UUID v4)
			bytes[6] = (bytes[6] & 0x0f) | 0x40;
			// Set variant to 10xx (RFC 4122)
			bytes[8] = (bytes[8] & 0x3f) | 0x80;

			const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
		} catch {
			// Fall through to pseudo-random fallback
		}
	}

	// 3. Compliant RFC 4122 v4 fallback using Date.now, performance.now, and Math.random
	let d = Date.now();
	let d2 = typeof performance !== 'undefined' && performance.now ? performance.now() * 1000 : 0;

	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
		let r = Math.random() * 16;
		if (d > 0) {
			r = ((d + r) % 16) | 0;
			d = Math.floor(d / 16);
		} else if (d2 > 0) {
			r = ((d2 + r) % 16) | 0;
			d2 = Math.floor(d2 / 16);
		} else {
			r = r | 0;
		}
		return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
	});
}

export const generateUuid = generateId;
