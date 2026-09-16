import { incidentOrganizationId } from './assignment';
import { matchSlaPolicy, createSlaSnapshot } from './sla';
import { canActOnIncident } from '$lib/auth/record-access';
import type {
	Incident,
	IncidentClosureType,
	IncidentPriority,
	IncidentStatus
} from '$lib/types/incident';
import type { SlaPolicy } from '$lib/types/sla';
import type { IncidentMessage } from '$lib/types/incident-message';
import type { AppUser } from '$lib/types/user';
import type { IncidentHistoryEntry, IncidentHistoryEventType } from '$lib/types/incident-history';
import type { IncidentCategory } from '$lib/types/category';
import type {
	ClassificationResult,
	ClassificationSnapshot,
	ImpactLevel,
	PriorityMatrix,
	Subcategory
} from '$lib/types/classification';
import { resolveCategoryRouting } from '$lib/categories/catalog';
import {
	classifyIncident,
	isImpactLevel,
	toIncidentPriority,
	toCalculatedPriority
} from '$lib/classification/engine';
import { resolveOrganizationMatrix } from '$lib/classification/matrix-catalog';
import { isIncidentList } from './validation';
import { isIncidentHistory } from './history';
import { generateId } from '$lib/utils/id';

export function buildCreatedHistoryEntry(
	incident: Incident,
	actorUserId: string,
	id: string = generateId()
): IncidentHistoryEntry {
	return {
		id,
		incidentId: incident.id,
		organizationId: incidentOrganizationId(incident),
		actorUserId,
		timestamp: incident.createdAt,
		eventType: 'created',
		newValue: {
			title: incident.title,
			status: incident.status,
			priority: incident.priority,
			supportLevel: incident.supportLevel ?? null,
			teamId: incident.teamId ?? null,
			assignedToUserId: incident.assignedToUserId ?? null
		}
	};
}

/** V2 priorities are classification output; manual priority editing remains V1-only until 2E. */
export function resolveEditedIncidentPriority(
	original: Incident,
	requested: IncidentPriority
): IncidentPriority {
	return original.classification ? original.priority : requested;
}

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

export interface ReclassifyIncidentInput {
	incident: Incident;
	actorUser: AppUser;
	newCategoryId: string;
	newSubcategoryId: string;
	newImpact: ImpactLevel;
	reason: string;
	categoryList: IncidentCategory[];
	subcategories: Subcategory[];
	priorityMatrices: PriorityMatrix[];
}

export type ReclassifyResult =
	| { ok: true; incident: Incident; historyEntry: IncidentHistoryEntry }
	| { ok: false; error: string };

/**
 * Reclasifica formalmente una incidencia V2 existente:
 * - Valida pertenencia organizacional y estado operativo (solo open y pending).
 * - Exige permiso incidents:classify.
 * - Rechaza operaciones sin cambios reales en taxonomía o impacto.
 * - Recalcula la prioridad mediante el motor determinista V2.
 * - Si existía un override previo, lo revoca automáticamente y audita la revocación en el evento reclassified.
 * - Preserva inmutables el snapshot SLA y el routing operativo (técnico, equipo, nivel).
 */
export function reclassifyIncident(input: ReclassifyIncidentInput): ReclassifyResult {
	const { incident } = input;
	if (!incident || typeof incident !== 'object') {
		return { ok: false, error: 'Incidencia inválida.' };
	}

	if (!incident.classification) {
		return { ok: false, error: 'Solo se pueden reclasificar incidencias con clasificación V2.' };
	}

	if (incident.status === 'closed') {
		return { ok: false, error: 'No se puede reclasificar una incidencia cerrada.' };
	}
	if (incident.status === 'resolved') {
		return {
			ok: false,
			error: 'No se puede reclasificar una incidencia resuelta. Debe reabrirse previamente.'
		};
	}
	if (incident.status !== 'open' && incident.status !== 'pending') {
		return {
			ok: false,
			error: 'Solo se pueden reclasificar incidencias abiertas o pendientes.'
		};
	}

	if (!canActOnIncident(input.actorUser, incident, 'incidents:classify')) {
		return { ok: false, error: 'No tienes permisos para reclasificar incidencias.' };
	}

	const cleanReason = typeof input.reason === 'string' ? input.reason.trim() : '';
	if (!cleanReason) {
		return { ok: false, error: 'El motivo de la reclasificación es obligatorio.' };
	}

	const cleanCatId = typeof input.newCategoryId === 'string' ? input.newCategoryId.trim() : '';
	const cleanSubcatId =
		typeof input.newSubcategoryId === 'string' ? input.newSubcategoryId.trim() : '';

	if (
		incident.categoryId === cleanCatId &&
		incident.subcategoryId === cleanSubcatId &&
		incident.classification.impactLevel === input.newImpact
	) {
		return {
			ok: false,
			error: 'No se han detectado cambios en la clasificación de la incidencia.'
		};
	}

	const orgId = incidentOrganizationId(incident);
	const matchedCat = input.categoryList.find(
		(c) => c.id === cleanCatId && (c.organizationId ? c.organizationId === orgId : true)
	);
	if (!matchedCat) {
		return {
			ok: false,
			error:
				'La categoría seleccionada no existe o no pertenece a la organización de la incidencia.'
		};
	}
	if (!matchedCat.active) {
		return { ok: false, error: 'La categoría seleccionada está inactiva.' };
	}

	const matchedSubcat = input.subcategories.find(
		(s) => s.id === cleanSubcatId && s.organizationId === orgId
	);
	if (!matchedSubcat) {
		return {
			ok: false,
			error: 'La subcategoría no existe o no pertenece a la organización de la incidencia.'
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

	if (!isImpactLevel(input.newImpact)) {
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
			impact: input.newImpact,
			matrix: resolvedMatrixResult.matrix,
			override: null
		});
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : 'Error al clasificar la incidencia.'
		};
	}

	const newOperationalPriority = toIncidentPriority(classificationResult.effectivePriority);
	const hadOverride = incident.classification.hasOverride === true;
	const overrideRevoked = hadOverride
		? {
				previousTargetPriority: incident.priority,
				...(incident.classification.overrideReason
					? { previousReason: incident.classification.overrideReason }
					: {}),
				...(incident.classification.overrideAuthorizedBy
					? { previousAuthorizedBy: incident.classification.overrideAuthorizedBy }
					: {})
			}
		: null;

	const now = new Date().toISOString();
	const updatedIncident: Incident = {
		...incident,
		categoryId: matchedCat.id,
		subcategoryId: matchedSubcat.id,
		classification: classificationResult.snapshot,
		priority: newOperationalPriority,
		updatedAt: now
	};

	const historyEntry: IncidentHistoryEntry = {
		id: generateId(),
		incidentId: incident.id,
		organizationId: orgId,
		actorUserId: input.actorUser.id,
		timestamp: now,
		eventType: 'reclassified',
		reason: cleanReason,
		newValue: {
			previousCategoryId: incident.categoryId ?? null,
			newCategoryId: matchedCat.id,
			previousSubcategoryId: incident.subcategoryId ?? null,
			newSubcategoryId: matchedSubcat.id,
			previousImpact: incident.classification.impactLevel ?? null,
			newImpact: input.newImpact,
			previousCalculatedPriority: toIncidentPriority(incident.classification.calculatedPriority),
			newCalculatedPriority: toIncidentPriority(classificationResult.calculatedPriority),
			previousEffectivePriority: incident.priority,
			newEffectivePriority: newOperationalPriority,
			overrideRevoked
		}
	};

	if (!isIncidentList([updatedIncident])) {
		return {
			ok: false,
			error: 'Error interno: la incidencia reclasificada no supera las validaciones de esquema.'
		};
	}

	if (!isIncidentHistory([historyEntry])) {
		return {
			ok: false,
			error: 'Error interno: el evento de historial generado no supera las validaciones de esquema.'
		};
	}

	return {
		ok: true,
		incident: updatedIncident,
		historyEntry
	};
}

export interface ApplyPriorityOverrideInput {
	incident: Incident;
	actorUser: AppUser;
	targetPriority: IncidentPriority;
	reason: string;
}

export type PriorityOverrideResult =
	| { ok: true; incident: Incident; historyEntry: IncidentHistoryEntry }
	| { ok: false; error: string };

/**
 * Aplica o modifica una excepción autorizada de prioridad (override) en una incidencia V2:
 * - Valida permisos (incidents:override_priority) y estado (open o pending).
 * - Exige motivo no vacío tras trim.
 * - Preserva inmutables la prioridad calculada base original, el SLA y el routing operativo.
 * - Registra priority_override_applied o priority_override_modified según corresponda.
 */
export function applyPriorityOverride(input: ApplyPriorityOverrideInput): PriorityOverrideResult {
	const { incident } = input;
	if (!incident || typeof incident !== 'object') {
		return { ok: false, error: 'Incidencia inválida.' };
	}

	if (!incident.classification) {
		return {
			ok: false,
			error: 'Solo se pueden aplicar excepciones de prioridad en incidencias con clasificación V2.'
		};
	}

	if (incident.status === 'closed') {
		return { ok: false, error: 'No se puede modificar la prioridad de una incidencia cerrada.' };
	}
	if (incident.status === 'resolved') {
		return {
			ok: false,
			error:
				'No se puede modificar la prioridad de una incidencia resuelta. Debe reabrirse previamente.'
		};
	}
	if (incident.status !== 'open' && incident.status !== 'pending') {
		return {
			ok: false,
			error:
				'Solo se pueden gestionar excepciones de prioridad en incidencias abiertas o pendientes.'
		};
	}

	if (!canActOnIncident(input.actorUser, incident, 'incidents:override_priority')) {
		return {
			ok: false,
			error: 'No tienes permisos para establecer excepciones de prioridad.'
		};
	}

	const cleanReason = typeof input.reason === 'string' ? input.reason.trim() : '';
	if (!cleanReason) {
		return { ok: false, error: 'El motivo de la excepción de prioridad es obligatorio.' };
	}

	const validPriorities: IncidentPriority[] = ['low', 'medium', 'high', 'urgent'];
	if (!validPriorities.includes(input.targetPriority)) {
		return { ok: false, error: 'Prioridad destino inválida.' };
	}

	if (incident.classification.hasOverride && incident.priority === input.targetPriority) {
		return {
			ok: false,
			error: 'La incidencia ya cuenta con una excepción de prioridad para ese mismo nivel.'
		};
	}

	const isModification = incident.classification.hasOverride === true;
	const eventType: 'priority_override_modified' | 'priority_override_applied' = isModification
		? 'priority_override_modified'
		: 'priority_override_applied';

	const targetCalculated = toCalculatedPriority(input.targetPriority);
	const newSnapshot: ClassificationSnapshot = {
		...incident.classification,
		effectivePriority: targetCalculated,
		hasOverride: true,
		overrideReason: cleanReason,
		overrideAuthorizedBy: input.actorUser.id
	};

	const now = new Date().toISOString();
	const updatedIncident: Incident = {
		...incident,
		priority: input.targetPriority,
		classification: newSnapshot,
		updatedAt: now
	};

	const orgId = incidentOrganizationId(incident);
	const historyEntry: IncidentHistoryEntry = {
		id: generateId(),
		incidentId: incident.id,
		organizationId: orgId,
		actorUserId: input.actorUser.id,
		timestamp: now,
		eventType,
		reason: cleanReason,
		newValue: {
			calculatedPriority: toIncidentPriority(incident.classification.calculatedPriority),
			previousEffectivePriority: incident.priority,
			newEffectivePriority: input.targetPriority
		}
	};

	if (!isIncidentList([updatedIncident])) {
		return {
			ok: false,
			error: 'Error interno: la incidencia con override no supera las validaciones de esquema.'
		};
	}

	if (!isIncidentHistory([historyEntry])) {
		return {
			ok: false,
			error: 'Error interno: el evento de historial generado no supera las validaciones de esquema.'
		};
	}

	return {
		ok: true,
		incident: updatedIncident,
		historyEntry
	};
}

export interface RemovePriorityOverrideInput {
	incident: Incident;
	actorUser: AppUser;
	reason: string;
}

/**
 * Retira una excepción autorizada de prioridad (override) activa:
 * - Valida que la incidencia cuente con override activo.
 * - Restablece la prioridad operativa igual a la prioridad calculada base original del snapshot.
 * - No requiere consultar catálogos vivos (evita bloqueos si una subcategoría fue desactivada con posterioridad).
 * - Registra el evento priority_override_removed.
 */
export function removePriorityOverride(input: RemovePriorityOverrideInput): PriorityOverrideResult {
	const { incident } = input;
	if (!incident || typeof incident !== 'object') {
		return { ok: false, error: 'Incidencia inválida.' };
	}

	if (!incident.classification) {
		return {
			ok: false,
			error: 'Solo se pueden gestionar excepciones en incidencias con clasificación V2.'
		};
	}

	if (!incident.classification.hasOverride) {
		return {
			ok: false,
			error: 'La incidencia no cuenta con ninguna excepción de prioridad activa para retirar.'
		};
	}

	if (incident.status === 'closed') {
		return { ok: false, error: 'No se puede modificar la prioridad de una incidencia cerrada.' };
	}
	if (incident.status === 'resolved') {
		return {
			ok: false,
			error:
				'No se puede modificar la prioridad de una incidencia resuelta. Debe reabrirse previamente.'
		};
	}
	if (incident.status !== 'open' && incident.status !== 'pending') {
		return {
			ok: false,
			error:
				'Solo se pueden gestionar excepciones de prioridad en incidencias abiertas o pendientes.'
		};
	}

	if (!canActOnIncident(input.actorUser, incident, 'incidents:override_priority')) {
		return {
			ok: false,
			error: 'No tienes permisos para retirar excepciones de prioridad.'
		};
	}

	const cleanReason = typeof input.reason === 'string' ? input.reason.trim() : '';
	if (!cleanReason) {
		return { ok: false, error: 'El motivo de la retirada de la excepción es obligatorio.' };
	}

	const restoredPriority = toIncidentPriority(incident.classification.calculatedPriority);
	const newSnapshot: ClassificationSnapshot = {
		...incident.classification,
		effectivePriority: incident.classification.calculatedPriority,
		hasOverride: false,
		overrideReason: undefined,
		overrideAuthorizedBy: undefined
	};

	const now = new Date().toISOString();
	const updatedIncident: Incident = {
		...incident,
		priority: restoredPriority,
		classification: newSnapshot,
		updatedAt: now
	};

	const orgId = incidentOrganizationId(incident);
	const historyEntry: IncidentHistoryEntry = {
		id: generateId(),
		incidentId: incident.id,
		organizationId: orgId,
		actorUserId: input.actorUser.id,
		timestamp: now,
		eventType: 'priority_override_removed',
		reason: cleanReason,
		newValue: {
			calculatedPriority: restoredPriority,
			previousEffectivePriority: incident.priority,
			newEffectivePriority: restoredPriority
		}
	};

	if (!isIncidentList([updatedIncident])) {
		return {
			ok: false,
			error:
				'Error interno: la incidencia al retirar el override no supera las validaciones de esquema.'
		};
	}

	if (!isIncidentHistory([historyEntry])) {
		return {
			ok: false,
			error: 'Error interno: el evento de historial generado no supera las validaciones de esquema.'
		};
	}

	return {
		ok: true,
		incident: updatedIncident,
		historyEntry
	};
}
