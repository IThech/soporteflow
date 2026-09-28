/**
 * Pure presentation helpers for the signed-in user (UI-1C). Derived only from real data
 * (name/email from /api/me); nothing is invented when both are missing.
 */
export function userInitials(name: string | null | undefined, email?: string | null): string {
	const words = (name ?? '')
		.trim()
		.split(/\s+/)
		.filter((word) => /\p{L}|\p{N}/u.test(word));
	const letters =
		words.length >= 2
			? [words[0], words[words.length - 1]]
			: words.length === 1
				? [words[0]]
				: [(email ?? '').trim()];
	const initials = letters
		.map((word) => Array.from(word.replace(/[^\p{L}\p{N}]/gu, ''))[0] ?? '')
		.join('')
		.toLocaleUpperCase('es');
	return initials || '?';
}
