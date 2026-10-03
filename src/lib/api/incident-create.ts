import { ApiError } from './errors.ts';
import {
	INCIDENT_CLIENT_MAX_LENGTH,
	INCIDENT_TITLE_MAX_LENGTH,
	assertIncidentIds,
	parseCreatedIncident,
	requestIncidentJson,
	type CreatedIncidentView,
	type IncidentRequestOptions
} from './incident-detail.ts';
import type { IncidentPriority } from './incident-views.ts';

/**
 * UI-2A — POST /api/incidents contract (frontend side). Exactly the properties the strict server
 * allowlist accepts (organizationId travels separately):
 *   title, description, client, clientId, priority, siteId, categoryId, subcategoryId, slaPolicyId.
 * Never sent: status (the server sets 'open'), supportLevel (server sets 'N1'), team/assignee,
 * attachments, and the requester: a manual creation is always requested by the authenticated
 * user, whom the SERVER sets as clientUserId (the endpoint rejects the property). `client` is a
 * free-text label (a company/customer name), unrelated to the requester user.
 *
 * Optional ids follow the server semantics:
 * - subcategoryId: only together with its categoryId (null = no subcategory); the server checks
 *   that it belongs to that category and organization;
 * - slaPolicyId: omitted -> the organization's default policy; null -> no SLA; UUID -> that
 *   policy. Sending it at all requires sla:assign (403 otherwise).
 * Validation mirrors only the real server rules (trimmed non-empty title/description/client,
 * title/client <= 255, enum priority, UUIDs). No invented description limit.
 */

export interface CreateIncidentRequest {
	title: string;
	description: string;
	clientId?: string | null;
	client?: string;
	priority: IncidentPriority;
	siteId?: string | null;
	categoryId?: string | null;
	/** Optional subcategory of categoryId (never without it). */
	subcategoryId?: string | null;
	slaPolicyId?: string | null;
}

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
	'title',
	'description',
	'client',
	'clientId',
	'priority',
	'siteId',
	'categoryId',
	'subcategoryId',
	'slaPolicyId'
]);
const PRIORITIES: readonly string[] = ['low', 'medium', 'high', 'urgent'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CreateIncidentField = keyof CreateIncidentRequest;

/** Client-side validation failure, tied to the offending field (nothing was sent). */
export class CreateIncidentInputError extends ApiError {
	readonly field: CreateIncidentField | null;
	constructor(field: CreateIncidentField | null, message: string) {
		super(0, 'INVALID_INPUT', message);
		this.name = 'CreateIncidentInputError';
		this.field = field;
	}
}

function requiredText(value: unknown, field: CreateIncidentField, label: string, max?: number) {
	if (typeof value !== 'string' || value.trim().length === 0)
		throw new CreateIncidentInputError(field, `${label} es obligatorio.`);
	const trimmed = value.trim();
	if (max !== undefined && trimmed.length > max)
		throw new CreateIncidentInputError(field, `${label} no puede superar ${max} caracteres.`);
	return trimmed;
}

function optionalId(value: unknown, field: CreateIncidentField, label: string) {
	if (value === undefined || value === null) return value;
	if (typeof value !== 'string' || !UUID.test(value))
		throw new CreateIncidentInputError(field, `${label} no es válido.`);
	return value;
}

/**
 * Validates and builds the exact POST body. Unknown properties are refused (a caller can never
 * smuggle status/supportLevel/teamId…); omitted optional ids stay omitted (server defaults).
 */
export function buildCreateIncidentPayload(
	organizationId: string,
	input: CreateIncidentRequest
): Record<string, unknown> {
	assertIncidentIds(organizationId);
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new CreateIncidentInputError(null, 'Los datos de la incidencia no son válidos.');
	for (const key of Object.keys(input))
		if (!ALLOWED_KEYS.has(key))
			throw new CreateIncidentInputError(null, 'Los datos de la incidencia no son válidos.');
	const payload: Record<string, unknown> = {
		organizationId,
		title: requiredText(input.title, 'title', 'El título', INCIDENT_TITLE_MAX_LENGTH),
		description: requiredText(input.description, 'description', 'La descripción')
	};
	if (input.clientId) {
		const val = optionalId(input.clientId, 'clientId', 'El cliente');
		payload.clientId = val;
		if (input.client) payload.client = input.client.trim();
	} else if (input.client) {
		payload.client = requiredText(input.client, 'client', 'El cliente', INCIDENT_CLIENT_MAX_LENGTH);
	} else {
		throw new CreateIncidentInputError('clientId', 'El cliente es obligatorio.');
	}
	if (typeof input.priority !== 'string' || !PRIORITIES.includes(input.priority))
		throw new CreateIncidentInputError('priority', 'La prioridad no es válida.');
	payload.priority = input.priority;
	const ids: [CreateIncidentField, string][] = [
		['siteId', 'La sede'],
		['categoryId', 'La categoría'],
		['subcategoryId', 'La subcategoría'],
		['slaPolicyId', 'La política SLA']
	];
	if (input.subcategoryId && !input.categoryId)
		throw new CreateIncidentInputError(
			'subcategoryId',
			'Elige una categoría antes de indicar la subcategoría.'
		);
	for (const [field, label] of ids) {
		const value = optionalId(input[field], field, label);
		if (value !== undefined) payload[field] = value;
	}
	return payload;
}

/**
 * Sends the creation. Pessimistic and single-shot: never retried here. The caller (a mutation
 * channel) classifies failures: a lost response is an UNKNOWN outcome, not a failure.
 */
export async function submitIncidentCreation(
	organizationId: string,
	input: CreateIncidentRequest,
	options: IncidentRequestOptions = {}
): Promise<CreatedIncidentView> {
	const payload = buildCreateIncidentPayload(organizationId, input);
	const { body, status, requestId } = await requestIncidentJson(
		'/api/incidents',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		},
		options
	);
	return parseCreatedIncident(body.incident, { organizationId }, status, requestId);
}
