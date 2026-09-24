export interface IncidentListItem {
	id: string;
	organizationId: string;
	incidentNumber: number;
	title: string;
	description: string;
	status: 'open' | 'pending' | 'resolved' | 'closed';
	priority: 'low' | 'medium' | 'high' | 'urgent';
	client: string;
	clientUserId: string | null;
	createdByUserId: string;
	siteId: string | null;
	createdAt: string;
	updatedAt: string;
}

export class IncidentApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'IncidentApiError';
		this.status = status;
		this.code = code;
	}
}

export interface ListIncidentsOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

/**
 * Fetches real multi-tenant incident list for the active organization.
 * Read-only client query against GET /api/incidents?organizationId=<UUID>.
 */
export async function listIncidents(
	organizationId: string,
	options?: ListIncidentsOptions
): Promise<IncidentListItem[]> {
	const fetchFn = options?.customFetch ?? fetch;
	const url = `/api/incidents?organizationId=${encodeURIComponent(organizationId)}`;

	let res: Response;
	try {
		res = await fetchFn(url, {
			method: 'GET',
			signal: options?.signal
		});
	} catch (err: unknown) {
		if (err instanceof IncidentApiError) {
			throw err;
		}
		if ((err as Error)?.name === 'AbortError' || options?.signal?.aborted) {
			throw err;
		}
		throw new IncidentApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}

	if (!res.ok) {
		let message = 'No se pudieron cargar las incidencias. Inténtalo de nuevo.';
		let code = 'INTERNAL_ERROR';
		if (res.status === 400) {
			message = 'No se pudo consultar la organización seleccionada.';
			code = 'INVALID_INPUT';
		} else if (res.status === 401) {
			message = 'Tu sesión ya no es válida.';
			code = 'UNAUTHORIZED';
		} else if (res.status === 403) {
			message = 'No tienes permisos para consultar las incidencias de esta organización.';
			code = 'FORBIDDEN';
		} else if (res.status === 404) {
			message = 'No se pudo cargar el listado de incidencias.';
			code = 'NOT_FOUND';
		} else if (res.status >= 500) {
			message = 'No se pudieron cargar las incidencias. Inténtalo de nuevo.';
			code = 'SERVER_ERROR';
		}
		throw new IncidentApiError(res.status, code, message);
	}

	let data: unknown;
	try {
		data = await res.json();
	} catch {
		throw new IncidentApiError(
			res.status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		throw new IncidentApiError(
			res.status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	const incidents = (data as { incidents?: unknown }).incidents;
	if (!Array.isArray(incidents)) {
		throw new IncidentApiError(
			res.status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	for (const inc of incidents) {
		if (!inc || typeof inc !== 'object') {
			throw new IncidentApiError(
				res.status,
				'INVALID_PAYLOAD',
				'No se pudo interpretar la respuesta del servidor.'
			);
		}
		const item = inc as Record<string, unknown>;
		if (
			typeof item.id !== 'string' ||
			typeof item.organizationId !== 'string' ||
			typeof item.incidentNumber !== 'number' ||
			typeof item.title !== 'string' ||
			typeof item.client !== 'string' ||
			typeof item.status !== 'string' ||
			typeof item.priority !== 'string' ||
			typeof item.createdAt !== 'string'
		) {
			throw new IncidentApiError(
				res.status,
				'INVALID_PAYLOAD',
				'No se pudo interpretar la respuesta del servidor.'
			);
		}
		if (item.organizationId !== organizationId) {
			throw new IncidentApiError(
				res.status,
				'INVALID_PAYLOAD',
				'No se pudo interpretar la respuesta del servidor.'
			);
		}
	}

	return incidents as IncidentListItem[];
}

export interface GetIncidentOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

/**
 * Fetches a single real incident by ID for the active organization.
 * Read-only client query against GET /api/incidents/<id>?organizationId=<UUID>.
 * Discards history and internal audit records to protect multi-tenant privacy.
 */
export async function getIncident(
	organizationId: string,
	incidentId: string,
	options?: GetIncidentOptions
): Promise<IncidentListItem> {
	const fetchFn = options?.customFetch ?? fetch;
	const url = `/api/incidents/${encodeURIComponent(incidentId)}?organizationId=${encodeURIComponent(organizationId)}`;

	let res: Response;
	try {
		res = await fetchFn(url, {
			method: 'GET',
			signal: options?.signal
		});
	} catch (err: unknown) {
		if (err instanceof IncidentApiError) {
			throw err;
		}
		if ((err as Error)?.name === 'AbortError' || options?.signal?.aborted) {
			throw err;
		}
		throw new IncidentApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}

	if (!res.ok) {
		let message = 'No se pudo cargar la incidencia. Inténtalo de nuevo.';
		let code = 'INTERNAL_ERROR';
		if (res.status === 400) {
			message = 'No se pudo consultar la incidencia.';
			code = 'INVALID_INPUT';
		} else if (res.status === 401) {
			message = 'Tu sesión ya no es válida.';
			code = 'UNAUTHORIZED';
		} else if (res.status === 403) {
			message = 'No tienes permisos para consultar esta incidencia.';
			code = 'FORBIDDEN';
		} else if (res.status === 404) {
			message = 'La incidencia no está disponible.';
			code = 'NOT_FOUND';
		} else if (res.status >= 500) {
			message = 'No se pudo cargar la incidencia. Inténtalo de nuevo.';
			code = 'SERVER_ERROR';
		}
		throw new IncidentApiError(res.status, code, message);
	}

	let data: unknown;
	try {
		data = await res.json();
	} catch {
		throw new IncidentApiError(
			res.status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		throw new IncidentApiError(
			res.status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	const incident = (data as { incident?: unknown }).incident;
	if (!incident || typeof incident !== 'object' || Array.isArray(incident)) {
		throw new IncidentApiError(
			res.status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	const item = incident as Record<string, unknown>;
	const isValidStatus =
		item.status === 'open' ||
		item.status === 'pending' ||
		item.status === 'resolved' ||
		item.status === 'closed';
	const isValidPriority =
		item.priority === 'low' ||
		item.priority === 'medium' ||
		item.priority === 'high' ||
		item.priority === 'urgent';
	const isValidClientUserId = item.clientUserId === null || typeof item.clientUserId === 'string';
	const isValidSiteId = item.siteId === null || typeof item.siteId === 'string';

	if (
		typeof item.id !== 'string' ||
		typeof item.organizationId !== 'string' ||
		typeof item.incidentNumber !== 'number' ||
		typeof item.title !== 'string' ||
		typeof item.description !== 'string' ||
		typeof item.client !== 'string' ||
		!isValidStatus ||
		!isValidPriority ||
		!isValidClientUserId ||
		typeof item.createdByUserId !== 'string' ||
		!isValidSiteId ||
		typeof item.createdAt !== 'string' ||
		typeof item.updatedAt !== 'string'
	) {
		throw new IncidentApiError(
			res.status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	if (item.organizationId !== organizationId || item.id !== incidentId) {
		throw new IncidentApiError(
			res.status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	return incident as IncidentListItem;
}
