import { isIP } from 'node:net';

/**
 * Outbound webhook target safety (5.4V-B): URL normalization and SSRF address classification.
 *
 * Primary control: EVERY resolved IP address of the target must be public unicast (checked at
 * creation and again at every send attempt, then the connection is pinned to a validated
 * address — see http-client.ts). Hostname rules are a secondary, non-exhaustive layer.
 */

export class WebhookTargetError extends Error {
	constructor(readonly code: 'INVALID_TARGET' | 'SSRF_BLOCKED' | 'DNS_RESOLUTION_FAILED') {
		super(code);
		this.name = 'WebhookTargetError';
	}
}

export const WEBHOOK_TARGET_URL_MAX_LENGTH = 2048;

/** Hostnames rejected before any DNS lookup (secondary layer; IP checks are authoritative). */
const BLOCKED_HOSTNAMES = new Set([
	'localhost',
	'metadata',
	'metadata.google.internal',
	'metadata.goog',
	'instance-data',
	'instance-data.ec2.internal'
]);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

/**
 * Canonical https URL: lowercase scheme/host, default port removed, path and query preserved.
 * Rejects non-https schemes, credentials, fragments, blocked hostnames and non-public IP literals.
 */
export function normalizeWebhookTargetUrl(raw: unknown): string {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > WEBHOOK_TARGET_URL_MAX_LENGTH)
		throw new WebhookTargetError('INVALID_TARGET');
	// eslint-disable-next-line no-control-regex
	if (/[\u0000- \u007f]/.test(raw)) throw new WebhookTargetError('INVALID_TARGET');
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new WebhookTargetError('INVALID_TARGET');
	}
	if (url.protocol !== 'https:') throw new WebhookTargetError('INVALID_TARGET');
	if (url.username || url.password) throw new WebhookTargetError('INVALID_TARGET');
	if (url.hash || raw.includes('#')) throw new WebhookTargetError('INVALID_TARGET');
	const host = hostnameOf(url);
	if (!host) throw new WebhookTargetError('INVALID_TARGET');
	if (isIP(host)) {
		if (!isPublicAddress(host)) throw new WebhookTargetError('SSRF_BLOCKED');
	} else {
		const name = host.replace(/\.$/, '');
		if (!name.includes('.') || BLOCKED_HOSTNAMES.has(name))
			throw new WebhookTargetError('SSRF_BLOCKED');
		if (BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix)))
			throw new WebhookTargetError('SSRF_BLOCKED');
	}
	const normalized = url.toString(); // WHATWG: lowercase scheme/host, drops :443
	if (normalized.length > WEBHOOK_TARGET_URL_MAX_LENGTH)
		throw new WebhookTargetError('INVALID_TARGET');
	return normalized;
}

/** Hostname without IPv6 brackets, lowercase. */
export function hostnameOf(url: URL): string {
	return url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

function ipv4Bytes(address: string): number[] | null {
	const parts = address.split('.');
	if (parts.length !== 4) return null;
	const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
	return bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? bytes : null;
}

function ipv6Bytes(address: string): number[] | null {
	let text = address.toLowerCase();
	const zone = text.indexOf('%');
	if (zone !== -1) text = text.slice(0, zone);
	let tail: number[] = [];
	const lastColon = text.lastIndexOf(':');
	if (text.slice(lastColon + 1).includes('.')) {
		const v4 = ipv4Bytes(text.slice(lastColon + 1));
		if (!v4) return null;
		tail = v4;
		text = text.slice(0, lastColon + 1) + '0:0';
	}
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const parse = (part: string) => (part === '' ? [] : part.split(':'));
	const head = parse(halves[0]);
	const rest = halves.length === 2 ? parse(halves[1]) : [];
	const missing = 8 - head.length - rest.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
	if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
	const bytes = groups.flatMap((g) => {
		const n = parseInt(g, 16);
		return [n >> 8, n & 0xff];
	});
	if (tail.length) bytes.splice(12, 4, ...tail);
	return bytes;
}

function publicIpv4(b: number[]): boolean {
	const [a, c] = [b[0], b[1]];
	if (a === 0) return false; // 0.0.0.0/8 "this network" / unspecified
	if (a === 10) return false; // RFC1918
	if (a === 100 && c >= 64 && c <= 127) return false; // 100.64/10 CGNAT
	if (a === 127) return false; // loopback
	if (a === 169 && c === 254) return false; // link-local (incl. cloud metadata)
	if (a === 172 && c >= 16 && c <= 31) return false; // RFC1918
	if (a === 192 && c === 0 && b[2] === 0) return false; // 192.0.0/24 IETF protocol assignments
	if (a === 192 && c === 0 && b[2] === 2) return false; // TEST-NET-1
	if (a === 192 && c === 88 && b[2] === 99) return false; // 6to4 relay anycast (deprecated)
	if (a === 192 && c === 168) return false; // RFC1918
	if (a === 198 && (c === 18 || c === 19)) return false; // benchmarking
	if (a === 198 && c === 51 && b[2] === 100) return false; // TEST-NET-2
	if (a === 203 && c === 0 && b[2] === 113) return false; // TEST-NET-3
	if (a >= 224) return false; // multicast 224/4, reserved 240/4, broadcast
	return true;
}

function publicIpv6(b: number[]): boolean {
	const zeroPrefix = (n: number) => b.slice(0, n).every((x) => x === 0);
	if (zeroPrefix(15) && (b[15] === 0 || b[15] === 1)) return false; // :: and ::1
	// IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d -> classify the embedded address
	if (zeroPrefix(10) && b[10] === 0xff && b[11] === 0xff) return publicIpv4(b.slice(12));
	if (zeroPrefix(12)) return publicIpv4(b.slice(12));
	// NAT64 64:ff9b::/96 embeds IPv4
	if (
		b[0] === 0x00 &&
		b[1] === 0x64 &&
		b[2] === 0xff &&
		b[3] === 0x9b &&
		b.slice(4, 12).every((x) => x === 0)
	)
		return publicIpv4(b.slice(12));
	if (b[0] === 0x20 && b[1] === 0x02) return publicIpv4(b.slice(2, 6)); // 6to4 2002::/16
	if ((b[0] & 0xfe) === 0xfc) return false; // fc00::/7 unique local
	if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false; // fe80::/10 link-local
	if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return false; // fec0::/10 site-local (deprecated)
	if (b[0] === 0xff) return false; // multicast
	if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // doc 2001:db8::/32
	if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return false; // Teredo 2001::/32
	return (b[0] & 0xe0) === 0x20; // only global unicast 2000::/3 (excludes 100::/64 discard etc.)
}

/** true only for public unicast IPv4/IPv6 addresses. Anything unparsable is not public. */
export function isPublicAddress(address: unknown): boolean {
	if (typeof address !== 'string') return false;
	const family = isIP(address.replace(/%.*$/, ''));
	if (family === 4) {
		const bytes = ipv4Bytes(address);
		return bytes !== null && publicIpv4(bytes);
	}
	if (family === 6) {
		const bytes = ipv6Bytes(address);
		return bytes !== null && publicIpv6(bytes);
	}
	return false;
}

export interface ResolvedAddress {
	address: string;
	family: 4 | 6;
}
export type WebhookLookup = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * Resolves the target host and requires EVERY address to be public (a single private/reserved
 * answer blocks the target: mixed public+private answers are a rebinding red flag).
 */
export async function resolvePublicAddresses(
	hostname: string,
	lookup: WebhookLookup
): Promise<ResolvedAddress[]> {
	if (isIP(hostname)) {
		if (!isPublicAddress(hostname)) throw new WebhookTargetError('SSRF_BLOCKED');
		return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
	}
	let addresses: ResolvedAddress[];
	try {
		addresses = await lookup(hostname);
	} catch {
		throw new WebhookTargetError('DNS_RESOLUTION_FAILED');
	}
	if (!Array.isArray(addresses) || addresses.length === 0)
		throw new WebhookTargetError('DNS_RESOLUTION_FAILED');
	if (addresses.some((a) => !isPublicAddress(a?.address)))
		throw new WebhookTargetError('SSRF_BLOCKED');
	return addresses;
}

/** Default resolver: node dns.promises.lookup with all addresses, IPv4 and IPv6. */
export const systemLookup: WebhookLookup = async (hostname) => {
	const { lookup } = await import('node:dns/promises');
	const results = await lookup(hostname, { all: true, verbatim: true });
	return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};
