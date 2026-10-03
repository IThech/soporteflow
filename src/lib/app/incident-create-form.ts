import type { ApiError } from '../api/errors.ts';
import {
	CreateIncidentInputError,
	buildCreateIncidentPayload,
	type CreateIncidentField,
	type CreateIncidentRequest
} from '../api/incident-create.ts';
import { INCIDENT_CLIENT_MAX_LENGTH, INCIDENT_TITLE_MAX_LENGTH } from '../api/incident-detail.ts';
import type { IncidentPriority } from '../api/incident-views.ts';
import { presentApiError } from './error-presentation.ts';
import type { CreatedIncidentOutcome } from './incident-create-controller.ts';
import type { MutationResult } from './mutation.ts';
import { tenantKey, type TenantIdentity } from './tenant-identity.ts';

/**
 * UI-2B — pure model of the "new incident" form (no Svelte, unit-tested in Node).
 *
 * The form edits a Draft; `toCreateRequest` turns it into the UI-2A CreateIncidentRequest:
 * - no requester: a manual creation is always requested by the authenticated user, whom the
 *   server sets as clientUserId (the form has no requester state and never sends it);
 * - SLA 'auto' -> slaPolicyId OMITTED (server default policy); 'none' -> null (explicit "no SLA");
 *   a policy -> its UUID. Choosing 'none'/a policy is only offered with the right capabilities;
 * - empty site/category -> omitted; with a category, subcategoryId is sent explicitly (its UUID, or
 *   null = "Sin subcategoría"); never a subcategory without its category.
 * Which optional sections exist depends ONLY on real capabilities (never roles):
 * - site: sites:view;   category: categories:view;
 * - SLA: sla:assign (else Automático only); naming a policy also needs sla:view.
 * Values for the optional selects only ever come from the real catalogs (no typed UUIDs).
 */

export const PRIORITY_OPTIONS: readonly { value: IncidentPriority; label: string }[] = [
	{ value: 'low', label: 'Baja' },
	{ value: 'medium', label: 'Media' },
	{ value: 'high', label: 'Alta' },
	{ value: 'urgent', label: 'Urgente' }
];

export interface CreateIncidentDraft {
	title: string;
	description: string;
	clientId: string;
	client: string;
	priority: IncidentPriority;
	/** '' = none. */
	siteId: string;
	/** '' = none. */
	categoryId: string;
	/** '' = none. Only meaningful under categoryId (the form drops it when the category changes). */
	subcategoryId: string;
	/** 'auto' | 'none' | policy UUID (select value). */
	sla: string;
}

export const SLA_AUTO = 'auto';
export const SLA_NONE = 'none';

export function emptyCreateDraft(): CreateIncidentDraft {
	return {
		title: '',
		description: '',
		clientId: '',
		client: '',
		priority: 'medium',
		siteId: '',
		categoryId: '',
		subcategoryId: '',
		sla: SLA_AUTO
	};
}

/** true when the user typed or chose anything (a discard must then be confirmed). */
export function isDraftDirty(draft: CreateIncidentDraft): boolean {
	const empty = emptyCreateDraft();
	return (Object.keys(empty) as (keyof CreateIncidentDraft)[]).some((key) =>
		typeof draft[key] === 'string' && typeof empty[key] === 'string'
			? (draft[key] as string).trim() !== (empty[key] as string)
			: draft[key] !== empty[key]
	);
}

export interface CreateFormSections {
	site: boolean;
	category: boolean;
	/** Offer SLA choices at all (Automático / Sin SLA). */
	sla: boolean;
	/** Offer named policies (needs the policies catalog). */
	slaPolicies: boolean;
	clients: boolean;
	readonly any: boolean;
}

export function createFormSections(capabilities: readonly string[]): CreateFormSections {
	const has = (id: string) => capabilities.includes(id);
	const sections = {
		site: has('sites:view'),
		category: has('categories:view'),
		sla: has('sla:assign'),
		slaPolicies: has('sla:assign') && has('sla:view'),
		clients: has('clients:view')
	};
	return { ...sections, any: Object.values(sections).some(Boolean) };
}

export type CreateFieldErrors = Partial<Record<CreateIncidentField, string>>;

/** Field order used to focus the first invalid field. */
export const CREATE_FIELD_ORDER: readonly CreateIncidentField[] = [
	'title',
	'description',
	'clientId',
	'client',
	'priority',
	'siteId',
	'categoryId',
	'subcategoryId',
	'slaPolicyId'
];

/** Same rules as the server (and UI-2A's payload builder); no invented limits. */
export function validateCreateDraft(draft: CreateIncidentDraft): CreateFieldErrors {
	const errors: CreateFieldErrors = {};
	const title = draft.title.trim();
	if (!title) errors.title = 'El título es obligatorio.';
	else if (title.length > INCIDENT_TITLE_MAX_LENGTH)
		errors.title = `El título no puede superar ${INCIDENT_TITLE_MAX_LENGTH} caracteres.`;
	if (!draft.description.trim()) errors.description = 'La descripción es obligatoria.';
	if (!draft.clientId && !draft.client.trim()) {
		errors.clientId = 'El cliente es obligatorio.';
	} else if (draft.client.trim().length > INCIDENT_CLIENT_MAX_LENGTH) {
		errors.client = `El cliente no puede superar ${INCIDENT_CLIENT_MAX_LENGTH} caracteres.`;
	}
	if (!PRIORITY_OPTIONS.some((option) => option.value === draft.priority))
		errors.priority = 'Selecciona una prioridad válida.';
	return errors;
}

/**
 * Draft -> UI-2A request. Optional values are only taken when their section is offered, so a
 * stale select value can never smuggle a field the user may not set.
 */
export function toCreateRequest(
	draft: CreateIncidentDraft,
	sections: CreateFormSections
): CreateIncidentRequest {
	const request: CreateIncidentRequest = {
		title: draft.title,
		description: draft.description,
		priority: draft.priority
	};
	if (draft.clientId) {
		request.clientId = draft.clientId;
	} else if (draft.client) {
		request.client = draft.client;
	}
	if (sections.site && draft.siteId) request.siteId = draft.siteId;
	if (sections.category && draft.categoryId) {
		request.categoryId = draft.categoryId;
		request.subcategoryId = draft.subcategoryId || null;
	}
	if (sections.sla) {
		if (draft.sla === SLA_NONE) request.slaPolicyId = null;
		else if (draft.sla !== SLA_AUTO && sections.slaPolicies) request.slaPolicyId = draft.sla;
		// SLA_AUTO: property omitted -> the server applies the organization's default policy.
	}
	return request;
}

/** Final gate before submitting: the UI-2A builder (same rules the controller will send). */
export function checkCreateRequest(
	organizationId: string,
	request: CreateIncidentRequest
): CreateFieldErrors {
	try {
		buildCreateIncidentPayload(organizationId, request);
		return {};
	} catch (error) {
		if (error instanceof CreateIncidentInputError && error.field)
			return { [error.field]: error.message };
		throw error;
	}
}

/** Server error codes of POST /api/incidents that belong to one field. */
const FIELD_ERRORS: Readonly<Record<string, [CreateIncidentField, string]>> = {
	CLIENT_NOT_FOUND: ['clientId', 'El cliente seleccionado ya no está disponible.'],
	CLIENT_INACTIVE: ['clientId', 'El cliente seleccionado está inactivo.'],
	SITE_NOT_FOUND: ['siteId', 'La sede seleccionada ya no está disponible.'],
	SITE_INACTIVE: ['siteId', 'La sede seleccionada está inactiva.'],
	CATEGORY_NOT_FOUND: ['categoryId', 'La categoría seleccionada ya no está disponible.'],
	CATEGORY_INACTIVE: ['categoryId', 'La categoría seleccionada está inactiva.'],
	SUBCATEGORY_NOT_FOUND: [
		'subcategoryId',
		'La subcategoría seleccionada ya no está disponible para esa categoría.'
	],
	SUBCATEGORY_INACTIVE: ['subcategoryId', 'La subcategoría seleccionada está inactiva.'],
	SLA_POLICY_NOT_FOUND: ['slaPolicyId', 'La política SLA seleccionada ya no está disponible.'],
	SLA_POLICY_INACTIVE: ['slaPolicyId', 'La política SLA seleccionada está inactiva.']
};

export interface CreateErrorView {
	title: string;
	message: string;
	requestId?: string;
	/** Error to show next to a field (the draft is always kept). */
	field?: { name: CreateIncidentField; message: string };
}

/**
 * Safe Spanish presentation of a definite creation failure. Backend messages are never shown
 * (they are technical English); only its stable code selects a field message.
 */
export function presentCreateError(error: ApiError): CreateErrorView {
	const base = presentApiError(error);
	const field = FIELD_ERRORS[error.code];
	if (field)
		return {
			title: 'Revisa los datos de la incidencia',
			message: field[1],
			requestId: base.requestId,
			field: { name: field[0], message: field[1] }
		};
	const messages: Partial<Record<ApiError['kind'], [string, string]>> = {
		'invalid-input': [
			'Revisa los datos de la incidencia',
			'El servidor no aceptó los datos. Revisa los campos y vuelve a intentarlo.'
		],
		forbidden: [
			'Acceso no permitido',
			'No tienes permisos para crear esta incidencia con los datos indicados.'
		],
		'payload-too-large': [
			'Solicitud demasiado grande',
			'El contenido es demasiado extenso. Reduce la descripción y vuelve a intentarlo.'
		],
		conflict: [
			'No se pudo crear la incidencia',
			'Los datos entran en conflicto con el estado actual. Revísalos y vuelve a intentarlo.'
		],
		unprocessable: [
			'No se pudo crear la incidencia',
			'La solicitud no se pudo procesar. Revisa los datos y vuelve a intentarlo.'
		],
		'not-found': [
			'No se pudo crear la incidencia',
			'Alguno de los datos seleccionados ya no está disponible.'
		]
	};
	const custom = messages[error.kind];
	return {
		title: custom?.[0] ?? base.title,
		message: custom?.[1] ?? base.message,
		requestId: base.requestId
	};
}

/**
 * What the page must do with a submission result (the page only executes it):
 * - `ignore`: stale (identity changed meanwhile) or busy — no navigation, message or draft change;
 * - `open-detail`: confirmed and readable — navigate to that incident of the SAME organization;
 * - `show-created`: confirmed but not readable — success notice, no detail navigation;
 * - `keep-draft`: definite error (field errors, optional 429 cooldown) or unknown outcome
 *   (verify before resending) — the draft is kept and nothing is resent automatically.
 */
export type CreationFollowUp =
	| { kind: 'ignore' }
	| { kind: 'open-detail'; incidentId: string; organizationId: string }
	| { kind: 'show-created' }
	| {
			kind: 'keep-draft';
			outcome: 'error' | 'unknown';
			fieldErrors: CreateFieldErrors;
			cooldownSeconds: number | null;
	  };

export function planCreationFollowUp(
	result: MutationResult<CreatedIncidentOutcome>,
	owner: TenantIdentity,
	current: TenantIdentity | null
): CreationFollowUp {
	if (result.status === 'stale' || result.status === 'busy') return { kind: 'ignore' };
	if (tenantKey(owner) !== tenantKey(current)) return { kind: 'ignore' };
	if (result.status === 'success')
		return result.value.readability === 'readable'
			? {
					kind: 'open-detail',
					incidentId: result.value.incident.id,
					organizationId: owner.organizationId
				}
			: { kind: 'show-created' };
	if (result.status === 'unknown')
		return { kind: 'keep-draft', outcome: 'unknown', fieldErrors: {}, cooldownSeconds: null };
	const view = presentCreateError(result.error);
	return {
		kind: 'keep-draft',
		outcome: 'error',
		fieldErrors: view.field ? { [view.field.name]: view.field.message } : {},
		cooldownSeconds:
			result.error.status === 429 && result.error.retryAfterSeconds !== undefined
				? result.error.retryAfterSeconds
				: null
	};
}
