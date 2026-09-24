export const STATUS_LABELS: Record<string, string> = {
	open: 'Abierta',
	pending: 'Pendiente',
	resolved: 'Resuelta',
	closed: 'Cerrada'
};

export const STATUS_STYLES: Record<string, string> = {
	open: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
	pending: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
	resolved: 'border-blue-500/30 bg-blue-500/10 text-blue-400',
	closed: 'border-slate-500/30 bg-slate-500/10 text-slate-400'
};

export const PRIORITY_LABELS: Record<string, string> = {
	low: 'Baja',
	medium: 'Media',
	high: 'Alta',
	urgent: 'Urgente'
};

export const PRIORITY_STYLES: Record<string, string> = {
	low: 'border-slate-500/20 bg-slate-500/10 text-slate-400',
	medium: 'border-blue-500/20 bg-blue-500/10 text-blue-400',
	high: 'border-amber-500/20 bg-amber-500/10 text-amber-400',
	urgent: 'border-rose-500/20 bg-rose-500/10 font-semibold text-rose-400'
};

export function formatDate(dateStr: string): string {
	if (!dateStr) return '';
	try {
		const d = new Date(dateStr);
		if (isNaN(d.getTime())) return dateStr;
		return new Intl.DateTimeFormat('es-ES', {
			day: '2-digit',
			month: '2-digit',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(d);
	} catch {
		return dateStr;
	}
}
