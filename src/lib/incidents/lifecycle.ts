import { incidentOrganizationId } from './assignment';
import { matchSlaPolicy, createSlaSnapshot } from './sla';
import type { Incident, IncidentClosureType, IncidentStatus } from '$lib/types/incident';
import type { SlaPolicy } from '$lib/types/sla';
import type { IncidentMessage } from '$lib/types/incident-message';
import type { AppUser } from '$lib/types/user';
import type { IncidentHistoryEntry, IncidentHistoryEventType } from '$lib/types/incident-history';
import type { IncidentCategory } from '$lib/types/category';
import type {
	ClassificationResult,
	ImpactLevel,
	PriorityMatrix,
	Subcategory
} from '$lib/types/classification';
import { resolveCategoryRouting } from '$lib/categories/catalog';
import { classifyIncident, isImpactLevel, toIncidentPriority } from '$lib/classification/engine';
import { resolveOrganizationMatrix } from '$lib/classification/matrix-catalog';
import { isIncidentList } from './validation';

/**
 * Applies initial SLA to an incident draft upon creation.
 * Source of truth for multi-tenant policy selection is the incident's organization,
 * not the acting user's profile.
 * If no matching policy or fallback exists, the incident remains without SLA.
 */
export function applyCreationSla(incident: Incident, policies: SlaPolicy[]): Incident {
	const orgId = incidentOrganizationId(incident);
	const orgPolicies = policies.filter((policy) => policy.organizationId === orgId);
	const policy = matchSlaPolicy(incident, orgPolicies);
	if (!policy) {
		return incident;
	}
	return {
		...incident,
		sla: createSlaSnapshot(incident, policy)
	};
}

/**
 * Checks whether a message qualifies as an initial staff response for SLA purposes:
 * - The incident has an active SLA snapshot with firstRespondedAt === null
 * - The message is public
 * - The author is staff (technician, organization_admin, or platform_admin)
 * - The message belongs to the incident
 */
export function isFirstResponseEligible(
	incident: Incident,
	message: Pick<IncidentMessage, 'visibility' | 'incidentId'>,
	actor: Pick<AppUser, 'role'>
): boolean {
	if (!incident.sla || incident.sla.firstRespondedAt !== null) {
		return false;
	}
	if (message.visibility !== 'public') {
		return false;
	}
	if (message.incidentId !== incident.id) {
		return false;
	}
	return ['technician', 'organization_admin', 'platform_admin'].includes(actor.role);
}

/**
 * Updates an incident's SLA snapshot with the first response timestamp if eligible.
 * Subsequent public messages do not alter an already recorded firstRespondedAt.
 */
export function recordFirstResponse(
	incident: Incident,
	message: IncidentMessage,
	actor: AppUser
): Incident {
	if (!isFirstResponseEligible(incident, message, actor)) {
		return incident;
	}
	return {
		...incident,
		sla: {
			...incident.sla!,
			firstRespondedAt: message.createdAt
		}
	};
}

export interface StatusTransitionOptions {
	closureType?: IncidentClosureType | null;
}

/**
 * Transitions an incident's status while preserving SLA commitments.
 * - If transitioning to 'resolved': sets incident.resolvedAt and incident.sla.resolvedAt = timestamp.
 * - If transitioning to 'closed': sets incident.closedAt and incident.closureType while preserving resolvedAt.
 * - If reopening ('resolved' | 'closed' -> 'open' | 'pending'): clears closure metadata while preserving SLA deadlines and historical resolvedAt.
 * - If transitioning again to 'resolved' after reopen: updates resolvedAt to the new timestamp.
 */
export function recordStatusTransition(
	incident: Incident,
	nextStatus: IncidentStatus,
	timestamp: string = new Date().toISOString(),
	options?: StatusTransitionOptions
): Incident {
	if (incident.status === nextStatus) {
		return incident;
	}

	if (nextStatus === 'resolved') {
		const base: Incident = {
			...incident,
			status: nextStatus,
			resolvedAt: timestamp,
			closedAt: null,
			closureType: null,
			updatedAt: timestamp
		};
		if (incident.sla) {
			return {
				...base,
				sla: {
					...incident.sla,
					resolvedAt: timestamp
				}
			};
		}
		return base;
	}

	if (nextStatus === 'closed') {
		return {
			...incident,
			status: nextStatus,
			resolvedAt: incident.resolvedAt ?? incident.sla?.resolvedAt ?? timestamp,
			closedAt: timestamp,
			closureType: options?.closureType ?? incident.closureType ?? 'client_confirmed',
			updatedAt: timestamp
		};
	}

	// Reopening or transition to 'open' | 'pending'
	return {
		...incident,
		status: nextStatus,
		closedAt: null,
		closureType: null,
		updatedAt: timestamp
	};
}

/**
 * Detects whether an incident is currently in a reopened state.
 * Reopened incidents have an active open status after having been resolved or closed.
 * Disappears once the incident is resolved or closed again.
 */
export function isIncidentReopened(incident: Incident, history?: IncidentHistoryEntry[]): boolean {
	if (incident.status === 'resolved' || incident.status === 'closed') {
		return false;
	}

	if (history && history.length > 0) {
		const incidentEvents = history.filter((e) => e.incidentId === incident.id);
		if (incidentEvents.length > 0) {
			const statusEvents: IncidentHistoryEventType[] = [
				'created',
				'resolved',
				'resolution_accepted',
				'closed',
				'resolution_rejected',
				'reopened',
				'status_changed'
			];

			const relevant = incidentEvents
				.filter((e) => statusEvents.includes(e.eventType))
				.sort(
					(a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id)
				);

			if (relevant.length > 0) {
				const last = relevant[relevant.length - 1];
				if (last.eventType === 'resolution_rejected' || last.eventType === 'reopened') {
					return true;
				}
				if (last.eventType === 'status_changed') {
					const prev = (last as { previousValue?: unknown }).previousValue;
					const next = (last as { newValue?: unknown }).newValue;
					if (
						(prev === 'resolved' || prev === 'closed') &&
						(next === 'open' || next === 'pending')
					) {
						return true;
					}
				}
				// If last status event was created, resolved, closed, resolution_accepted, or regular status_changed
				return false;
			}
		}
	}

	// Fallback when history is not available:
	// In the lifecycle, reopening preserves historical resolvedAt while resetting closedAt.
	return incident.status === 'open' && incident.resolvedAt != null;
}

export interface ValidateAndBuildV2IncidentInput {
	id: number;
	title: string;
	client: string;
	description: string;
	siteId?: string | null;
	activeUser: AppUser;
	categoryId: string;
	subcategoryId: string;
	impact: ImpactLevel | string;
	categoryList: IncidentCategory[];
	subcategories: Subcategory[];
	priorityMatrices: PriorityMatrix[];
	slaPolicies?: SlaPolicy[];
}

export type ValidateAndBuildV2IncidentResult =
	| { ok: true; incident: Incident; classification: ClassificationResult }
	| { ok: false; error: string };

/**
 * Validates all preconditions and builds a fully classified V2 Incident.
 * Reuses existing domain modules and strict schema validators.
 */
export function validateAndBuildV2Incident(
	input: ValidateAndBuildV2IncidentInput
): ValidateAndBuildV2IncidentResult {
	if (!input.activeUser || typeof input.activeUser !== 'object') {
		return { ok: false, error: 'Usuario no autenticado o contexto de usuario inválido.' };
	}

	const orgId = input.activeUser.organizationId;
	if (!orgId || typeof orgId !== 'string' || orgId.trim().length === 0) {
		return { ok: false, error: 'El usuario no tiene una organización asignada.' };
	}

	const cleanTitle = typeof input.title === 'string' ? input.title.trim() : '';
	const cleanClient =
		input.activeUser.role === 'client'
			? input.activeUser.name
			: typeof input.client === 'string'
				? input.client.trim()
				: '';
	const cleanDescription = typeof input.description === 'string' ? input.description.trim() : '';

	if (!cleanTitle || !cleanClient || !cleanDescription) {
		return {
			ok: false,
			error: 'Completa el título, el cliente y la descripción del problema.'
		};
	}

	const categoryId = typeof input.categoryId === 'string' ? input.categoryId.trim() : '';
	if (!categoryId) {
		return { ok: false, error: 'Selecciona una categoría obligatoria.' };
	}

	const matchedCat = input.categoryList.find(
		(c) => c.id === categoryId && (c.organizationId ? c.organizationId === orgId : true)
	);
	if (!matchedCat) {
		return {
			ok: false,
			error: 'La categoría seleccionada no existe o no pertenece a tu organización.'
		};
	}
	if (!matchedCat.active) {
		return { ok: false, error: 'La categoría seleccionada está inactiva.' };
	}

	const subcategoryId = typeof input.subcategoryId === 'string' ? input.subcategoryId.trim() : '';
	if (!subcategoryId) {
		return { ok: false, error: 'Selecciona una subcategoría obligatoria.' };
	}

	const matchedSubcat = input.subcategories.find(
		(s) => s.id === subcategoryId && s.organizationId === orgId
	);
	if (!matchedSubcat) {
		return {
			ok: false,
			error: 'La subcategoría no existe o no pertenece a tu organización.'
		};
	}
	if (matchedSubcat.categoryId !== matchedCat.id) {
		return {
			ok: false,
			error: 'La subcategoría no pertenece a la categoría seleccionada.'
		};
	}
	if (!matchedSubcat.active) {
		return { ok: false, error: 'La subcategoría seleccionada está inactiva.' };
	}

	if (!isImpactLevel(input.impact)) {
		return {
			ok: false,
			error: 'Selecciona un nivel de impacto válido (I1 a I4).'
		};
	}

	let resolvedMatrixResult;
	try {
		resolvedMatrixResult = resolveOrganizationMatrix(input.priorityMatrices, orgId);
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : 'Error al resolver la matriz de prioridad.'
		};
	}

	if (resolvedMatrixResult.status === 'corrupt') {
		return {
			ok: false,
			error: resolvedMatrixResult.error || 'El catálogo de matrices de prioridad está corrupto.'
		};
	}

	let classificationResult: ClassificationResult;
	try {
		classificationResult = classifyIncident({
			subcategory: matchedSubcat,
			impact: input.impact,
			matrix: resolvedMatrixResult.matrix
		});
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : 'Error al clasificar la incidencia.'
		};
	}

	const operationalPriority = toIncidentPriority(classificationResult.effectivePriority);
	const categoryRouting = resolveCategoryRouting(matchedCat);

	const draft: Incident = {
		id: input.id,
		organizationId: orgId,
		createdByUserId: input.activeUser.id,
		...(input.activeUser.role === 'client' ? { clientUserId: input.activeUser.id } : {}),
		title: cleanTitle,
		client: cleanClient,
		description: cleanDescription,
		solution: '',
		status: 'open',
		priority: operationalPriority,
		createdAt: new Date().toISOString(),
		siteId: input.siteId ? input.siteId : null,
		categoryId: matchedCat.id,
		subcategoryId: matchedSubcat.id,
		classification: classificationResult.snapshot,
		...categoryRouting
	};

	const incidentWithSla = input.slaPolicies ? applyCreationSla(draft, input.slaPolicies) : draft;

	if (!isIncidentList([incidentWithSla])) {
		return {
			ok: false,
			error: 'Error interno: la incidencia generada no supera las validaciones de esquema.'
		};
	}

	return {
		ok: true,
		incident: incidentWithSla,
		classification: classificationResult
	};
}
