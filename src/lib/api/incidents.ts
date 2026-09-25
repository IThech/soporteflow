export interface IncidentListItem {
	id: string;
	organizationId: string;
	incidentNumber: number;
	title: string;
	description: string;
	status: 'open' | 'pending' | 'resolved' | 'closed';
	priority: 'low' | 'medium' | 'high' | 'urgent';
	supportLevel: 'N1' | 'N2' | 'N3';
	client: string;
	clientUserId: string | null;
	createdByUserId: string;
	siteId: string | null;
	assignedToUserId: string | null;
	assignedToUserName?: string | null;
	teamId?: string | null;
	teamName?: string | null;
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

export type IncidentQueue = 'mine' | 'unassigned' | 'all';
export type SupportLevel = 'N1' | 'N2' | 'N3';

export interface ListIncidentsOptions {
	queue?: IncidentQueue;
	status?: 'open' | 'pending' | 'resolved' | 'closed';
	priority?: 'low' | 'medium' | 'high' | 'urgent';
	siteId?: string;
	supportLevel?: SupportLevel;
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
	let url = `/api/incidents?organizationId=${encodeURIComponent(organizationId)}`;
	if (options?.queue) {
		url += `&queue=${encodeURIComponent(options.queue)}`;
	}
	if (options?.status) {
		url += `&status=${encodeURIComponent(options.status)}`;
	}
	if (options?.priority) {
		url += `&priority=${encodeURIComponent(options.priority)}`;
	}
	if (options?.siteId) {
		url += `&siteId=${encodeURIComponent(options.siteId)}`;
	}
	if (options?.supportLevel) {
		url += `&supportLevel=${encodeURIComponent(options.supportLevel)}`;
	}

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
			message = options?.queue
				? 'No tienes permisos para consultar esta cola.'
				: 'No tienes permisos para consultar las incidencias de esta organización.';
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
	return parseAndValidateIncident(incident, organizationId, incidentId, res.status);
}

function parseAndValidateIncident(
	rawItem: unknown,
	expectedOrgId: string,
	expectedIncidentId?: string,
	status = 200
): IncidentListItem {
	if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
		throw new IncidentApiError(
			status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	const item = rawItem as Record<string, unknown>;
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
	const isValidAssignedToUserId =
		item.assignedToUserId === undefined ||
		item.assignedToUserId === null ||
		typeof item.assignedToUserId === 'string';
	const isValidAssignedToUserName =
		item.assignedToUserName === undefined ||
		item.assignedToUserName === null ||
		typeof item.assignedToUserName === 'string';
	const isValidTeamId =
		item.teamId === undefined || item.teamId === null || typeof item.teamId === 'string';
	const isValidTeamName =
		item.teamName === undefined || item.teamName === null || typeof item.teamName === 'string';
	const isValidSupportLevel =
		typeof item.supportLevel === 'string' &&
		(item.supportLevel === 'N1' || item.supportLevel === 'N2' || item.supportLevel === 'N3');

	if (
		typeof item.id !== 'string' ||
		typeof item.organizationId !== 'string' ||
		typeof item.incidentNumber !== 'number' ||
		typeof item.title !== 'string' ||
		typeof item.description !== 'string' ||
		typeof item.client !== 'string' ||
		!isValidStatus ||
		!isValidPriority ||
		!isValidSupportLevel ||
		!isValidClientUserId ||
		typeof item.createdByUserId !== 'string' ||
		!isValidSiteId ||
		!isValidAssignedToUserId ||
		!isValidAssignedToUserName ||
		!isValidTeamId ||
		!isValidTeamName ||
		typeof item.createdAt !== 'string' ||
		typeof item.updatedAt !== 'string'
	) {
		throw new IncidentApiError(
			status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	if (item.assignedToUserId === undefined) {
		item.assignedToUserId = null;
	}
	if (item.teamId === undefined) {
		item.teamId = null;
	}
	if (item.teamName === undefined) {
		item.teamName = null;
	}

	if (item.organizationId !== expectedOrgId) {
		throw new IncidentApiError(
			status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	if (expectedIncidentId !== undefined && item.id !== expectedIncidentId) {
		throw new IncidentApiError(
			status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	return item as unknown as IncidentListItem;
}

export interface CreateIncidentInput {
	title: string;
	description: string;
	client: string;
	priority: 'low' | 'medium' | 'high' | 'urgent';
}

export interface CreateIncidentOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

/**
 * Creates a new real incident for the specified organization.
 * Sends POST /api/incidents with Content-Type: application/json.
 * Validates the complete IncidentListItem contract on success.
 * Discards history and internal audit records.
 */
export async function createIncident(
	organizationId: string,
	input: CreateIncidentInput,
	options?: CreateIncidentOptions
): Promise<IncidentListItem> {
	const fetchFn = options?.customFetch ?? fetch;
	const url = '/api/incidents';

	let res: Response;
	try {
		res = await fetchFn(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				organizationId,
				title: input.title,
				description: input.description,
				client: input.client,
				priority: input.priority
			}),
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
		let message = 'No se pudo crear la incidencia. Inténtalo de nuevo.';
		let code = 'INTERNAL_ERROR';
		if (res.status === 400) {
			message = 'Por favor, revisa los datos de la incidencia.';
			code = 'INVALID_INPUT';
		} else if (res.status === 401) {
			message = 'Tu sesión ya no es válida.';
			code = 'UNAUTHORIZED';
		} else if (res.status === 403) {
			message = 'No tienes permisos para crear incidencias en esta organización.';
			code = 'FORBIDDEN';
		} else if (res.status === 404) {
			message = 'No se pudo asociar la sede o el cliente especificado.';
			code = 'NOT_FOUND';
		} else if (res.status >= 500) {
			message = 'No se pudo crear la incidencia. Inténtalo de nuevo.';
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
	return parseAndValidateIncident(incident, organizationId, undefined, res.status);
}

export interface UpdateIncidentInput {
	status?: 'open' | 'pending' | 'resolved' | 'closed';
	priority?: 'low' | 'medium' | 'high' | 'urgent';
}

export interface UpdateIncidentOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

/**
 * Updates an incident's status and/or priority for the specified organization.
 * Sends PATCH /api/incidents/<id>?organizationId=<orgId> with Content-Type: application/json.
 * Validates the complete IncidentListItem contract on success.
 * Discards history and internal audit records.
 */
export async function updateIncident(
	organizationId: string,
	incidentId: string,
	input: UpdateIncidentInput,
	options?: UpdateIncidentOptions
): Promise<IncidentListItem> {
	const fetchFn = options?.customFetch ?? fetch;
	const url = `/api/incidents/${encodeURIComponent(incidentId)}?organizationId=${encodeURIComponent(organizationId)}`;

	let res: Response;
	try {
		res = await fetchFn(url, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(input),
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
		let message = 'No se pudo actualizar la incidencia. Inténtalo de nuevo.';
		let code = 'INTERNAL_ERROR';
		if (res.status === 400) {
			message = 'Por favor, revisa los cambios de la incidencia.';
			code = 'INVALID_INPUT';
		} else if (res.status === 401) {
			message = 'Tu sesión ya no es válida.';
			code = 'UNAUTHORIZED';
		} else if (res.status === 403) {
			message = 'No tienes permisos para modificar esta incidencia.';
			code = 'FORBIDDEN';
		} else if (res.status === 404) {
			message = 'La incidencia no está disponible.';
			code = 'NOT_FOUND';
		} else if (res.status >= 500) {
			message = 'No se pudo actualizar la incidencia. Inténtalo de nuevo.';
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
	return parseAndValidateIncident(incident, organizationId, incidentId, res.status);
}

export interface IncidentTeam {
	id: string;
	name: string;
	description: string | null;
}

export interface ListTeamsOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

/**
 * Fetches real active teams for the active organization.
 * Read-only client query against GET /api/teams?organizationId=<UUID>.
 */
export async function listTeams(
	organizationId: string,
	options?: ListTeamsOptions
): Promise<IncidentTeam[]> {
	const fetchFn = options?.customFetch ?? fetch;
	const url = `/api/teams?organizationId=${encodeURIComponent(organizationId)}`;

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
		let message = 'No se pudieron cargar los equipos. Inténtalo de nuevo.';
		let code = 'INTERNAL_ERROR';
		if (res.status === 400) {
			message = 'No se pudo consultar la organización seleccionada.';
			code = 'INVALID_INPUT';
		} else if (res.status === 401) {
			message = 'Tu sesión ya no es válida.';
			code = 'UNAUTHORIZED';
		} else if (res.status === 403) {
			message = 'No tienes permisos para consultar los equipos de esta organización.';
			code = 'FORBIDDEN';
		} else if (res.status === 404) {
			message = 'No se encontró el recurso solicitado.';
			code = 'NOT_FOUND';
		} else if (res.status >= 500) {
			message = 'No se pudieron cargar los equipos. Inténtalo de nuevo.';
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

	const teams = (data as { teams?: unknown }).teams;
	if (!Array.isArray(teams)) {
		throw new IncidentApiError(
			res.status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	for (const t of teams) {
		if (!t || typeof t !== 'object') {
			throw new IncidentApiError(
				res.status,
				'INVALID_PAYLOAD',
				'No se pudo interpretar la respuesta del servidor.'
			);
		}
		const item = t as Record<string, unknown>;
		const isValidDesc = item.description === null || typeof item.description === 'string';
		if (typeof item.id !== 'string' || typeof item.name !== 'string' || !isValidDesc) {
			throw new IncidentApiError(
				res.status,
				'INVALID_PAYLOAD',
				'No se pudo interpretar la respuesta del servidor.'
			);
		}
	}

	return teams as IncidentTeam[];
}

export interface IncidentAssignee {
	id: string;
	name: string;
}

export interface AssignIncidentInput {
	teamId?: string | null;
	assignedToUserId?: string | null;
	reason?: string;
}

export interface ListAssigneesOptions {
	teamId?: string;
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

/**
 * Fetches assignable technicians for the active organization.
 * Read-only client query against GET /api/incidents/assignees?organizationId=<UUID>.
 */
export async function listAssignees(
	organizationId: string,
	options?: ListAssigneesOptions
): Promise<IncidentAssignee[]> {
	const fetchFn = options?.customFetch ?? fetch;
	let url = `/api/incidents/assignees?organizationId=${encodeURIComponent(organizationId)}`;
	if (options?.teamId) {
		url += `&teamId=${encodeURIComponent(options.teamId)}`;
	}

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
		let message = 'No se pudieron cargar los técnicos disponibles. Inténtalo de nuevo.';
		let code = 'INTERNAL_ERROR';
		if (res.status === 400) {
			message = 'No se pudo consultar la organización seleccionada.';
			code = 'INVALID_INPUT';
		} else if (res.status === 401) {
			message = 'Tu sesión ya no es válida.';
			code = 'UNAUTHORIZED';
		} else if (res.status === 403) {
			message = 'No tienes permisos para asignar incidencias.';
			code = 'FORBIDDEN';
		} else if (res.status === 404) {
			message = 'No se encontró el recurso solicitado.';
			code = 'NOT_FOUND';
		} else if (res.status >= 500) {
			message = 'No se pudieron cargar los técnicos disponibles. Inténtalo de nuevo.';
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

	const assignees = (data as { assignees?: unknown }).assignees;
	if (!Array.isArray(assignees)) {
		throw new IncidentApiError(
			res.status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}

	for (const a of assignees) {
		if (!a || typeof a !== 'object') {
			throw new IncidentApiError(
				res.status,
				'INVALID_PAYLOAD',
				'No se pudo interpretar la respuesta del servidor.'
			);
		}
		const item = a as Record<string, unknown>;
		if (typeof item.id !== 'string' || typeof item.name !== 'string') {
			throw new IncidentApiError(
				res.status,
				'INVALID_PAYLOAD',
				'No se pudo interpretar la respuesta del servidor.'
			);
		}
	}

	return assignees as IncidentAssignee[];
}

export interface AssignIncidentOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

/**
 * Assigns or reassigns an incident to a technician.
 * Invokes POST /api/incidents/<id>/assign?organizationId=<UUID>.
 */
export async function assignIncident(
	organizationId: string,
	incidentId: string,
	input: AssignIncidentInput,
	options?: AssignIncidentOptions
): Promise<IncidentListItem> {
	const fetchFn = options?.customFetch ?? fetch;
	const url = `/api/incidents/${encodeURIComponent(incidentId)}/assign?organizationId=${encodeURIComponent(organizationId)}`;

	const payload: Record<string, unknown> = {};
	if (input.teamId !== undefined) {
		payload.teamId = input.teamId;
	}
	if (input.assignedToUserId !== undefined) {
		payload.assignedToUserId = input.assignedToUserId;
	}
	if (input.reason !== undefined) {
		payload.reason = input.reason;
	}

	let res: Response;
	try {
		res = await fetchFn(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload),
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
		let message = 'No se pudo asignar la incidencia. Inténtalo de nuevo.';
		let code = 'INTERNAL_ERROR';
		if (res.status === 400) {
			message = 'Los datos de asignación son inválidos.';
			code = 'INVALID_INPUT';
		} else if (res.status === 401) {
			message = 'Tu sesión ya no es válida.';
			code = 'UNAUTHORIZED';
		} else if (res.status === 403) {
			message = 'No tienes permisos para asignar esta incidencia.';
			code = 'FORBIDDEN';
		} else if (res.status === 404) {
			message = 'No se pudo realizar la asignación.';
			code = 'NOT_FOUND';
		} else if (res.status >= 500) {
			message = 'No se pudo asignar la incidencia. Inténtalo de nuevo.';
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

	const rawIncident = (data as { incident?: unknown }).incident;
	const parsed = parseAndValidateIncident(rawIncident, organizationId, incidentId, res.status);
	return parsed;
}

export interface UpdateIncidentSupportLevelInput {
	supportLevel: SupportLevel;
	reason?: string;
}

export interface UpdateIncidentSupportLevelOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

/**
 * Updates the support level (N1, N2, N3) of an incident.
 * Invokes PATCH /api/incidents/<id>/support-level?organizationId=<UUID>.
 */
export async function updateIncidentSupportLevel(
	organizationId: string,
	incidentId: string,
	input: UpdateIncidentSupportLevelInput,
	options?: UpdateIncidentSupportLevelOptions
): Promise<IncidentListItem> {
	const fetchFn = options?.customFetch ?? fetch;
	const url = `/api/incidents/${encodeURIComponent(incidentId)}/support-level?organizationId=${encodeURIComponent(organizationId)}`;

	const payload: Record<string, unknown> = {
		supportLevel: input.supportLevel
	};
	if (input.reason !== undefined) {
		payload.reason = input.reason;
	}

	let res: Response;
	try {
		res = await fetchFn(url, {
			method: 'PATCH',
			headers: {
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(payload),
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
		let message = 'No se pudo actualizar el nivel de soporte. Inténtalo de nuevo.';
		let code = 'INTERNAL_ERROR';
		if (res.status === 400) {
			message = 'Los datos para actualizar el nivel son inválidos.';
			code = 'INVALID_INPUT';
		} else if (res.status === 401) {
			message = 'Tu sesión ya no es válida.';
			code = 'UNAUTHORIZED';
		} else if (res.status === 403) {
			message = 'No tienes permisos para modificar el nivel de esta incidencia.';
			code = 'FORBIDDEN';
		} else if (res.status === 404) {
			message = 'La incidencia no está disponible.';
			code = 'NOT_FOUND';
		} else if (res.status >= 500) {
			message = 'No se pudo actualizar el nivel de soporte. Inténtalo de nuevo.';
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

	const rawIncident = (data as { incident?: unknown }).incident;
	const parsed = parseAndValidateIncident(rawIncident, organizationId, incidentId, res.status);
	return parsed;
}

export interface UpdateIncidentSiteInput {
	/** Target site UUID, or null to remove the site. */
	siteId: string | null;
	/** Required by the server when replacing or removing an existing site. */
	reason?: string;
}

export interface UpdateIncidentSiteOptions {
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

const SITE_CHANGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Changes or removes the site of an incident.
 * Invokes PATCH /api/incidents/<id>/site?organizationId=<UUID> with body { siteId, reason? }.
 */
export async function updateIncidentSite(
	organizationId: string,
	incidentId: string,
	input: UpdateIncidentSiteInput,
	options?: UpdateIncidentSiteOptions
): Promise<IncidentListItem> {
	if (
		!SITE_CHANGE_UUID.test(organizationId) ||
		!SITE_CHANGE_UUID.test(incidentId) ||
		(input?.siteId !== null && !SITE_CHANGE_UUID.test(String(input?.siteId))) ||
		(input.reason !== undefined && typeof input.reason !== 'string')
	) {
		throw new IncidentApiError(0, 'INVALID_INPUT', 'Los datos del cambio de sede no son válidos.');
	}
	const fetchFn = options?.customFetch ?? fetch;
	const url = `/api/incidents/${encodeURIComponent(incidentId)}/site?${new URLSearchParams({ organizationId }).toString()}`;
	const payload: Record<string, unknown> = { siteId: input.siteId };
	if (input.reason !== undefined) payload.reason = input.reason;

	let res: Response;
	try {
		res = await fetchFn(url, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
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
		let backendCode: unknown;
		try {
			backendCode = ((await res.json()) as { error?: { code?: unknown } })?.error?.code;
		} catch {
			backendCode = undefined;
		}
		let message = 'No se pudo cambiar la sede. Inténtalo de nuevo.';
		let code = 'INTERNAL_ERROR';
		if (res.status === 400) {
			message = 'Revisa la sede seleccionada y el motivo del cambio.';
			code = 'INVALID_INPUT';
		} else if (res.status === 401) {
			message = 'Tu sesión ya no es válida.';
			code = 'UNAUTHORIZED';
		} else if (res.status === 403) {
			message = 'No tienes permisos para modificar la sede de esta incidencia.';
			code = 'FORBIDDEN';
		} else if (res.status === 404) {
			if (backendCode === 'SITE_NOT_FOUND') {
				message = 'La sede seleccionada no está disponible.';
				code = 'SITE_NOT_FOUND';
			} else {
				message = 'La incidencia no está disponible.';
				code = 'NOT_FOUND';
			}
		} else if (res.status === 409) {
			message =
				backendCode === 'SITE_INACTIVE'
					? 'La sede seleccionada está inactiva.'
					: 'No se pudo cambiar la sede. Inténtalo de nuevo.';
			code = backendCode === 'SITE_INACTIVE' ? 'SITE_INACTIVE' : 'CONFLICT';
		} else if (res.status >= 500) {
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
	const parsed = parseAndValidateIncident(
		(data as { incident?: unknown }).incident,
		organizationId,
		incidentId,
		res.status
	);
	if ((parsed.siteId ?? null) !== input.siteId) {
		throw new IncidentApiError(
			res.status,
			'INVALID_PAYLOAD',
			'No se pudo interpretar la respuesta del servidor.'
		);
	}
	return parsed;
}

// =============================================================================
// Incident messages: public comments and internal notes (5.4N)
// =============================================================================

export interface IncidentMessageAuthor {
	name: string;
}

interface IncidentMessageBase {
	id: string;
	body: string;
	/** Backend ISO string with microseconds; kept as string to preserve precision. */
	createdAt: string;
	author: IncidentMessageAuthor;
}

export type IncidentPublicComment = IncidentMessageBase;
export type IncidentInternalNote = IncidentMessageBase;

export interface IncidentCommentPage {
	items: IncidentPublicComment[];
	nextCursor: string | null;
}

export interface IncidentInternalNotePage {
	items: IncidentInternalNote[];
	nextCursor: string | null;
}

export interface ListIncidentMessagesInput {
	organizationId: string;
	incidentId: string;
	limit?: number;
	cursor?: string;
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

export interface CreateIncidentMessageInput {
	organizationId: string;
	incidentId: string;
	body: string;
	signal?: AbortSignal;
	customFetch?: typeof fetch;
}

const MESSAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const MESSAGE_CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
const MESSAGE_MAX_LENGTH = 4000;

/** Fixed per exported function; never derived from caller input. */
type MessageEndpoint = 'comments' | 'internal-notes';

const MESSAGE_TEXT: Record<
	MessageEndpoint,
	{ list: string; create: string; forbidden: string; closed: string; invalid: string }
> = {
	comments: {
		list: 'No se pudieron cargar los comentarios. Inténtalo de nuevo.',
		create: 'No se pudo publicar el comentario. Inténtalo de nuevo.',
		forbidden: 'No tienes permisos para acceder a los comentarios de esta incidencia.',
		closed: 'La incidencia está cerrada y no admite nuevos comentarios.',
		invalid: 'Revisa el texto del comentario.'
	},
	'internal-notes': {
		list: 'No se pudieron cargar las notas internas. Inténtalo de nuevo.',
		create: 'No se pudo guardar la nota interna. Inténtalo de nuevo.',
		forbidden: 'No tienes permisos para acceder a las notas internas de esta incidencia.',
		closed: 'La incidencia está cerrada y no admite nuevas notas internas.',
		invalid: 'Revisa el texto de la nota interna.'
	}
};

function invalidPayload(status: number): IncidentApiError {
	return new IncidentApiError(
		status,
		'INVALID_PAYLOAD',
		'No se pudo interpretar la respuesta del servidor.'
	);
}

function messageUrl(
	endpoint: MessageEndpoint,
	organizationId: string,
	incidentId: string,
	query: Record<string, string> = {}
): string {
	if (
		typeof organizationId !== 'string' ||
		typeof incidentId !== 'string' ||
		!MESSAGE_UUID.test(organizationId) ||
		!MESSAGE_UUID.test(incidentId)
	) {
		throw new IncidentApiError(0, 'INVALID_INPUT', 'Identificador de incidencia no válido.');
	}
	const params = new URLSearchParams({ organizationId, ...query });
	return `/api/incidents/${encodeURIComponent(incidentId)}/${endpoint}?${params.toString()}`;
}

async function sendMessageRequest(
	fetchFn: typeof fetch,
	url: string,
	init: RequestInit,
	signal: AbortSignal | undefined
): Promise<Response> {
	try {
		return await fetchFn(url, { ...init, signal });
	} catch (err: unknown) {
		if (err instanceof IncidentApiError) {
			throw err;
		}
		if ((err as Error)?.name === 'AbortError' || signal?.aborted) {
			throw err;
		}
		throw new IncidentApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
	}
}

/** Maps HTTP failures to safe, fixed messages. Only the backend error code is read, never its message. */
async function messageFailure(
	res: Response,
	endpoint: MessageEndpoint,
	action: 'list' | 'create'
): Promise<IncidentApiError> {
	const text = MESSAGE_TEXT[endpoint];
	if (res.status === 400) {
		return new IncidentApiError(
			400,
			'INVALID_INPUT',
			action === 'create' ? text.invalid : text.list
		);
	}
	if (res.status === 401) {
		return new IncidentApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
	}
	if (res.status === 403) {
		return new IncidentApiError(403, 'FORBIDDEN', text.forbidden);
	}
	if (res.status === 404) {
		return new IncidentApiError(404, 'NOT_FOUND', 'La incidencia no está disponible.');
	}
	if (res.status === 409) {
		let backendCode: unknown;
		try {
			backendCode = ((await res.json()) as { error?: { code?: unknown } })?.error?.code;
		} catch {
			backendCode = undefined;
		}
		return backendCode === 'INCIDENT_CLOSED'
			? new IncidentApiError(409, 'INCIDENT_CLOSED', text.closed)
			: new IncidentApiError(409, 'CONFLICT', text[action]);
	}
	if (res.status >= 500) {
		return new IncidentApiError(res.status, 'SERVER_ERROR', text[action]);
	}
	return new IncidentApiError(res.status, 'INTERNAL_ERROR', text[action]);
}

async function readJsonObject(res: Response): Promise<Record<string, unknown>> {
	let data: unknown;
	try {
		data = await res.json();
	} catch {
		throw invalidPayload(res.status);
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		throw invalidPayload(res.status);
	}
	return data as Record<string, unknown>;
}

/** Strict allowlist: rebuilds the item so no extra backend field reaches the UI. */
function parseIncidentMessage(raw: unknown, status: number): IncidentMessageBase {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidPayload(status);
	const item = raw as Record<string, unknown>;
	const author = item.author as Record<string, unknown> | null | undefined;
	if (
		typeof item.id !== 'string' ||
		!MESSAGE_UUID.test(item.id) ||
		typeof item.body !== 'string' ||
		item.body.length === 0 ||
		item.body.length > MESSAGE_MAX_LENGTH ||
		typeof item.createdAt !== 'string' ||
		!MESSAGE_CREATED_AT.test(item.createdAt) ||
		Number.isNaN(Date.parse(item.createdAt)) ||
		!author ||
		typeof author !== 'object' ||
		Array.isArray(author) ||
		typeof author.name !== 'string' ||
		author.name.trim().length === 0
	) {
		throw invalidPayload(status);
	}
	return {
		id: item.id,
		body: item.body,
		createdAt: item.createdAt,
		author: { name: author.name }
	};
}

function parseIncidentMessagePage(
	data: Record<string, unknown>,
	status: number
): { items: IncidentMessageBase[]; nextCursor: string | null } {
	const { items, nextCursor } = data;
	if (!Array.isArray(items)) throw invalidPayload(status);
	if (nextCursor !== null && (typeof nextCursor !== 'string' || !MESSAGE_CURSOR.test(nextCursor))) {
		throw invalidPayload(status);
	}
	const parsed = items.map((item) => parseIncidentMessage(item, status));
	if (new Set(parsed.map((item) => item.id)).size !== parsed.length) throw invalidPayload(status);
	return { items: parsed, nextCursor };
}

async function listIncidentMessages(
	endpoint: MessageEndpoint,
	input: ListIncidentMessagesInput
): Promise<{ items: IncidentMessageBase[]; nextCursor: string | null }> {
	const query: Record<string, string> = {};
	if (input.limit !== undefined) {
		if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
			throw new IncidentApiError(0, 'INVALID_INPUT', 'El tamaño de página no es válido.');
		}
		query.limit = String(input.limit);
	}
	if (input.cursor !== undefined) {
		if (typeof input.cursor !== 'string' || !MESSAGE_CURSOR.test(input.cursor)) {
			throw new IncidentApiError(0, 'INVALID_INPUT', 'El cursor de paginación no es válido.');
		}
		query.cursor = input.cursor;
	}
	const url = messageUrl(endpoint, input.organizationId, input.incidentId, query);
	const res = await sendMessageRequest(
		input.customFetch ?? fetch,
		url,
		{ method: 'GET' },
		input.signal
	);
	if (!res.ok) throw await messageFailure(res, endpoint, 'list');
	return parseIncidentMessagePage(await readJsonObject(res), res.status);
}

async function createIncidentMessage(
	endpoint: MessageEndpoint,
	input: CreateIncidentMessageInput
): Promise<IncidentMessageBase> {
	if (typeof input.body !== 'string') {
		throw new IncidentApiError(0, 'INVALID_INPUT', MESSAGE_TEXT[endpoint].invalid);
	}
	const url = messageUrl(endpoint, input.organizationId, input.incidentId);
	const res = await sendMessageRequest(
		input.customFetch ?? fetch,
		url,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			// Exact contract: only { body }; identity, tenant and message type are server-derived.
			body: JSON.stringify({ body: input.body })
		},
		input.signal
	);
	if (!res.ok) throw await messageFailure(res, endpoint, 'create');
	const data = await readJsonObject(res);
	return parseIncidentMessage(data.item, res.status);
}

/** GET /api/incidents/<id>/comments?organizationId=<UUID>[&limit][&cursor]. Public comments only. */
export async function listIncidentComments(
	input: ListIncidentMessagesInput
): Promise<IncidentCommentPage> {
	return listIncidentMessages('comments', input);
}

/** POST /api/incidents/<id>/comments?organizationId=<UUID> with body { body }. */
export async function createIncidentComment(
	input: CreateIncidentMessageInput
): Promise<IncidentPublicComment> {
	return createIncidentMessage('comments', input);
}

/** GET /api/incidents/<id>/internal-notes?organizationId=<UUID>[&limit][&cursor]. Internal notes only. */
export async function listIncidentInternalNotes(
	input: ListIncidentMessagesInput
): Promise<IncidentInternalNotePage> {
	return listIncidentMessages('internal-notes', input);
}

/** POST /api/incidents/<id>/internal-notes?organizationId=<UUID> with body { body }. */
export async function createIncidentInternalNote(
	input: CreateIncidentMessageInput
): Promise<IncidentInternalNote> {
	return createIncidentMessage('internal-notes', input);
}
