import { canAccessOrganization, hasPermission } from '$lib/auth/permissions';
import { normalizeSearchText } from '$lib/incidents/queue';
import { demoSlaPolicies } from '$lib/data/sla';
import { isSlaPolicyList } from '$lib/incidents/sla';
import type { SlaPolicy } from '$lib/types/sla';
import type { AppUser } from '$lib/types/user';
import type { IncidentCategory } from '$lib/types/category';
import type { IncidentPriority } from '$lib/types/incident';

export const SLA_POLICIES_KEY = 'soporteflow-sla-policies';

export type SlaPolicyLoadResult =
	| { status: 'missing'; seededPolicies: SlaPolicy[] }
	| { status: 'valid'; policies: SlaPolicy[] }
	| { status: 'corrupt'; error: string };

export type SlaPolicyCatalogState =
	{ status: 'valid'; policies: SlaPolicy[] } | { status: 'corrupt'; error: string; raw: string };

export type SlaPolicyChange =
	| {
			type: 'save';
			id?: string;
			name: string;
			description?: string;
			isDefault: boolean;
			categoryId?: string | null;
			priority?: IncidentPriority | null;
			firstResponseMinutes: number;
			resolutionMinutes: number;
	  }
	| {
			type: 'toggle';
			id: string;
	  };

const normalizedName = (name: string) => normalizeSearchText(name).replace(/\s+/g, '');

const priorityLabels: Record<IncidentPriority, string> = {
	low: 'Baja',
	medium: 'Media',
	high: 'Alta'
};

/**
 * Loads SLA policies from raw localStorage string, explicitly differentiating
 * between missing (uninitialized), valid (including empty list), and corrupt.
 */
export function loadSlaPoliciesResult(raw: string | null): SlaPolicyLoadResult {
	if (raw === null) {
		return {
			status: 'missing',
			seededPolicies: demoSlaPolicies.map((policy) => ({ ...policy }))
		};
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (isSlaPolicyList(parsed)) {
			return {
				status: 'valid',
				policies: parsed
			};
		}
		return {
			status: 'corrupt',
			error: 'El catálogo de políticas SLA guardado está corrupto o no cumple el esquema.'
		};
	} catch {
		return {
			status: 'corrupt',
			error: 'El contenido guardado de políticas SLA no es un JSON válido.'
		};
	}
}

/**
 * Saves SLA policies to storage with optimistic concurrency check.
 */
export function saveSlaPolicies(
	storage: Pick<Storage, 'getItem' | 'setItem'>,
	list: SlaPolicy[],
	expected: string | null
): string {
	if (storage.getItem(SLA_POLICIES_KEY) !== expected) {
		throw new Error(
			'El catálogo de políticas SLA ha cambiado en otra pestaña. Recarga antes de continuar.'
		);
	}
	if (!isSlaPolicyList(list)) {
		throw new Error('El catálogo de políticas SLA no tiene un formato válido.');
	}
	const raw = JSON.stringify(list);
	storage.setItem(SLA_POLICIES_KEY, raw);
	return raw;
}

/**
 * Validates business rules and prevents duplicate active policy scopes within the same organization.
 * Rules:
 * - Max one active default per organization.
 * - Default cannot have categoryId or priority.
 * - Non-default policies must define at least categoryId or priority.
 * - No two active policies in the same org can share the exact same scope:
 *   (default, category+priority, category-only, priority-only).
 * - Names of active policies must be unique within the organization.
 * - Inactive policies do NOT generate conflicts, but are validated when reactivated.
 */
export function validatePolicyConflicts(
	candidate: SlaPolicy,
	existingPolicies: SlaPolicy[]
): string | null {
	const trimmedName = candidate.name.trim();
	if (!trimmedName) {
		return 'Escribe un nombre para la política.';
	}

	if (
		!Number.isSafeInteger(candidate.firstResponseMinutes) ||
		candidate.firstResponseMinutes <= 0
	) {
		return 'El tiempo de primera respuesta debe ser un número entero positivo.';
	}

	if (!Number.isSafeInteger(candidate.resolutionMinutes) || candidate.resolutionMinutes <= 0) {
		return 'El tiempo de resolución debe ser un número entero positivo.';
	}

	if (candidate.isDefault) {
		if (
			candidate.categoryId !== undefined &&
			candidate.categoryId !== null &&
			candidate.categoryId !== ''
		) {
			return 'Una política predeterminada no puede definir una categoría.';
		}
		if (candidate.priority !== undefined && candidate.priority !== null) {
			return 'Una política predeterminada no puede definir una prioridad.';
		}
	} else {
		const hasCategory =
			candidate.categoryId !== undefined &&
			candidate.categoryId !== null &&
			candidate.categoryId.trim() !== '';
		const hasPriority = candidate.priority !== undefined && candidate.priority !== null;
		if (!hasCategory && !hasPriority) {
			return 'Una política específica debe definir al menos una categoría o una prioridad.';
		}
	}

	// Conflict checks only apply if candidate is active
	if (!candidate.active) {
		return null;
	}

	const otherActive = existingPolicies.filter(
		(p) => p.id !== candidate.id && p.organizationId === candidate.organizationId && p.active
	);

	// Check name uniqueness among active policies of the same organization
	const normName = normalizedName(trimmedName);
	if (otherActive.some((p) => normalizedName(p.name) === normName)) {
		return 'Ya existe una política activa con ese nombre en la organización.';
	}

	// Check default scope conflict
	if (candidate.isDefault) {
		if (otherActive.some((p) => p.isDefault)) {
			return 'Ya existe una política predeterminada activa para esta organización.';
		}
		return null;
	}

	// Check specific scope conflicts
	const candCat = candidate.categoryId || null;
	const candPrio = candidate.priority || null;

	const duplicateScope = otherActive.find(
		(p) => !p.isDefault && (p.categoryId || null) === candCat && (p.priority || null) === candPrio
	);

	if (duplicateScope) {
		return 'Ya existe una política activa con el mismo ámbito en la organización. Desactiva o modifica la existente.';
	}

	return null;
}

/**
 * Applies a create/edit or toggle change to the policy catalog with permission and tenant isolation checks.
 */
export function changeSlaPolicy(
	actor: AppUser,
	list: SlaPolicy[],
	change: SlaPolicyChange
): SlaPolicy[] {
	if (!hasPermission(actor, 'sla:manage')) {
		throw new Error('No tienes permiso para gestionar políticas SLA.');
	}

	const timestamp = new Date().toISOString();

	if (change.type === 'toggle') {
		const original = list.find((item) => item.id === change.id);
		if (!original) {
			throw new Error('La política SLA ya no está disponible.');
		}
		if (!canAccessOrganization(actor, original.organizationId)) {
			throw new Error('No puedes gestionar políticas de esta organización.');
		}

		// If currently active -> deactivating is always allowed
		if (original.active) {
			return list.map((item) =>
				item.id === original.id ? { ...item, active: false, updatedAt: timestamp } : item
			);
		}

		// If currently inactive -> reactivating requires conflict re-validation
		const reactivated: SlaPolicy = { ...original, active: true, updatedAt: timestamp };
		const conflict = validatePolicyConflicts(reactivated, list);
		if (conflict) {
			throw new Error(conflict);
		}

		return list.map((item) => (item.id === original.id ? reactivated : item));
	}

	// Type: 'save' (create or edit)
	const original = change.id === undefined ? undefined : list.find((item) => item.id === change.id);
	if (change.id !== undefined && !original) {
		throw new Error('La política SLA ya no está disponible.');
	}

	const organizationId = original?.organizationId ?? actor.organizationId;
	if (!organizationId || !canAccessOrganization(actor, organizationId)) {
		throw new Error('No puedes gestionar políticas de esta organización.');
	}

	const candidate: SlaPolicy = {
		id: original ? original.id : crypto.randomUUID(),
		organizationId,
		name: change.name.trim(),
		description: change.description?.trim() || undefined,
		active: original ? original.active : true,
		isDefault: change.isDefault,
		categoryId: change.isDefault ? null : change.categoryId || null,
		priority: change.isDefault ? null : change.priority || null,
		firstResponseMinutes: change.firstResponseMinutes,
		resolutionMinutes: change.resolutionMinutes,
		createdAt: original ? original.createdAt : timestamp,
		updatedAt: original ? timestamp : undefined
	};

	const error = validatePolicyConflicts(candidate, list);
	if (error) {
		throw new Error(error);
	}

	return original
		? list.map((item) => (item.id === original.id ? candidate : item))
		: [...list, candidate];
}

/**
 * Lossless conversion from minutes to friendly time input.
 * Strictly uses days only if exactly divisible by 1440.
 * Strictly uses hours only if exactly divisible by 60.
 * Never rounds and never produces decimal hours or days.
 */
export function minutesToTimeInput(totalMinutes: number): {
	value: number;
	unit: 'minutes' | 'hours' | 'days';
} {
	const absolute = Math.abs(Math.round(totalMinutes));
	if (absolute > 0 && absolute % 1440 === 0) {
		return { value: absolute / 1440, unit: 'days' };
	}
	if (absolute > 0 && absolute % 60 === 0) {
		return { value: absolute / 60, unit: 'hours' };
	}
	return { value: absolute, unit: 'minutes' };
}

/**
 * Converts user-friendly input value and unit to natural minutes.
 */
export function timeInputToMinutes(value: number, unit: 'minutes' | 'hours' | 'days'): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error('El tiempo debe ser un número entero positivo.');
	}
	switch (unit) {
		case 'days':
			return value * 1440;
		case 'hours':
			return value * 60;
		case 'minutes':
		default:
			return value;
	}
}

/**
 * Returns active policies belonging to a specific organization.
 */
export function activeSlaPolicies(policies: SlaPolicy[], organizationId: string): SlaPolicy[] {
	return policies.filter((policy) => policy.active && policy.organizationId === organizationId);
}

/**
 * Formats a user-friendly, human-readable scope label for an SLA policy.
 */
export function formatSlaPolicyScope(
	policy: SlaPolicy,
	categories: IncidentCategory[] = []
): string {
	if (policy.isDefault) {
		return 'Predeterminada';
	}
	const catName = policy.categoryId
		? (categories.find((c) => c.id === policy.categoryId)?.name ?? policy.categoryId)
		: null;
	const prioName = policy.priority ? priorityLabels[policy.priority] : null;

	if (catName && prioName) {
		return `${catName} + ${prioName}`;
	}
	if (catName) {
		return catName;
	}
	if (prioName) {
		return `Prioridad ${prioName}`;
	}
	return 'Sin regla definida';
}

/**
 * Verifies whether incident creation is permitted under the current SLA catalog state.
 * If catalog is corrupt, blocks creation and provides an explicit error message.
 * If catalog is valid, permits creation and returns the active policies for the organization.
 * Never falls back to demoSlaPolicies when corrupt.
 */
export function checkIncidentCreationSla(
	catalogState: SlaPolicyCatalogState,
	organizationId: string
): { allowed: true; policies: SlaPolicy[] } | { allowed: false; error: string } {
	if (catalogState.status === 'corrupt') {
		return {
			allowed: false,
			error:
				'No se puede crear la incidencia: el catálogo de políticas SLA está corrupto. Corrige la configuración de almacenamiento antes de continuar.'
		};
	}
	return {
		allowed: true,
		policies: activeSlaPolicies(catalogState.policies, organizationId)
	};
}
