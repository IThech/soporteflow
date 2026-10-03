/**
 * Calendar date of a catalog row ("2 oct 2026"), shared by the admin tables (sites, clients,
 * categories). One formatter instance for every row. An unparsable value renders as an em dash,
 * the same placeholder the tables use for empty fields (never "Invalid Date").
 */
const SHORT_DATE = new Intl.DateTimeFormat('es-ES', {
	day: 'numeric',
	month: 'short',
	year: 'numeric'
});

export function formatShortDate(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? '—' : SHORT_DATE.format(date);
}
