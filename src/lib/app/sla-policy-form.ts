import {
	SLA_TARGET_MAX_MINUTES,
	type SlaPolicy,
	type UpdateSlaPolicyPatch
} from '../api/sla-policies.ts';

/**
 * SLA policy administration (SLA-1A): durations and the create/edit form model. Pure TypeScript
 * (no fetch, no DOM). The backend stays the authority (/api/sla-policies re-validates everything);
 * these rules only give early, field-level feedback with the same limits:
 * - targets are whole minutes 1..SLA_TARGET_MAX_MINUTES (24x7 elapsed) and resolution >= first
 *   response;
 * - code: 3..50 chars, lowercase snake_case, immutable after creation (never in a PATCH);
 * - name 1..100 chars, description <= 1000 (empty -> null);
 * - a default policy is always active (a policy being deactivated cannot stay the default).
 */

export type DurationUnit = 'minutes' | 'hours' | 'days';

export const DURATION_UNITS: readonly { value: DurationUnit; label: string }[] = [
	{ value: 'minutes', label: 'minutos' },
	{ value: 'hours', label: 'horas' },
	{ value: 'days', label: 'días' }
];

const UNIT_MINUTES: Record<DurationUnit, number> = { minutes: 1, hours: 60, days: 1440 };

export const SLA_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const SLA_CODE_MIN_LENGTH = 3;
export const SLA_CODE_MAX_LENGTH = 50;
export const SLA_NAME_MAX_LENGTH = 100;
export const SLA_DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Human, deterministic duration: whole days, hours and minutes, largest first, zero parts
 * omitted ("15 min", "1 h 30 min", "1 d", "1 d 2 h"). Never "90 minutos".
 */
export function formatSlaDuration(minutes: number): string {
	if (!Number.isSafeInteger(minutes) || minutes < 1) return '—';
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	const parts: string[] = [];
	if (days) parts.push(`${days} d`);
	if (hours) parts.push(`${hours} h`);
	if (mins) parts.push(`${mins} min`);
	return parts.join(' ');
}

/** The largest unit that represents `minutes` exactly (editing never loses precision). */
export function splitDuration(minutes: number): { value: string; unit: DurationUnit } {
	if (minutes % 1440 === 0) return { value: String(minutes / 1440), unit: 'days' };
	if (minutes % 60 === 0) return { value: String(minutes / 60), unit: 'hours' };
	return { value: String(minutes), unit: 'minutes' };
}

/**
 * value + unit -> minutes, or an error. Only plain positive integers are accepted ("4", not
 * "4.5", "4h", "-1" or "1e3"): no float arithmetic, no ambiguous rounding.
 */
export function toMinutes(
	value: string,
	unit: DurationUnit
): { ok: true; minutes: number } | { ok: false; error: string } {
	const text = value.trim();
	if (!text) return { ok: false, error: 'Indica un tiempo.' };
	if (!/^\d+$/.test(text) || !Object.hasOwn(UNIT_MINUTES, unit))
		return { ok: false, error: 'Usa un número entero positivo.' };
	const amount = Number(text);
	const minutes = amount * UNIT_MINUTES[unit];
	if (!Number.isSafeInteger(minutes) || minutes < 1)
		return { ok: false, error: 'Usa un número entero positivo.' };
	if (minutes > SLA_TARGET_MAX_MINUTES)
		return {
			ok: false,
			error: `El máximo es ${formatSlaDuration(SLA_TARGET_MAX_MINUTES)} (${SLA_TARGET_MAX_MINUTES / 1440} días).`
		};
	return { ok: true, minutes };
}

export interface SlaPolicyDraft {
	code: string;
	name: string;
	description: string;
	firstResponseValue: string;
	firstResponseUnit: DurationUnit;
	resolutionValue: string;
	resolutionUnit: DurationUnit;
	/** Edit only: a new policy is always active (POST has no `active`). */
	active: boolean;
	isDefault: boolean;
}

export type SlaPolicyField = 'code' | 'name' | 'description' | 'firstResponse' | 'resolution';
export type SlaPolicyErrors = Partial<Record<SlaPolicyField, string>>;

/** Focus order for the first invalid field. */
export const SLA_POLICY_FIELD_ORDER: readonly SlaPolicyField[] = [
	'name',
	'code',
	'description',
	'firstResponse',
	'resolution'
];

export function emptySlaPolicyDraft(): SlaPolicyDraft {
	return {
		code: '',
		name: '',
		description: '',
		firstResponseValue: '',
		firstResponseUnit: 'hours',
		resolutionValue: '',
		resolutionUnit: 'hours',
		active: true,
		isDefault: false
	};
}

export function draftFromPolicy(policy: SlaPolicy): SlaPolicyDraft {
	const firstResponse = splitDuration(policy.firstResponseMinutes);
	const resolution = splitDuration(policy.resolutionMinutes);
	return {
		code: policy.code,
		name: policy.name,
		description: policy.description ?? '',
		firstResponseValue: firstResponse.value,
		firstResponseUnit: firstResponse.unit,
		resolutionValue: resolution.value,
		resolutionUnit: resolution.unit,
		active: policy.active,
		isDefault: policy.isDefault
	};
}

export interface ValidSlaPolicy {
	code: string;
	name: string;
	description: string | null;
	firstResponseMinutes: number;
	resolutionMinutes: number;
	active: boolean;
	isDefault: boolean;
}

/** Field errors, or the normalized values when the draft is valid. `create` checks the code. */
export function validateSlaPolicyDraft(
	draft: SlaPolicyDraft,
	mode: 'create' | 'edit'
): { ok: true; value: ValidSlaPolicy } | { ok: false; errors: SlaPolicyErrors } {
	const errors: SlaPolicyErrors = {};
	const name = draft.name.trim();
	if (!name) errors.name = 'El nombre es obligatorio.';
	else if (name.length > SLA_NAME_MAX_LENGTH)
		errors.name = `El nombre no puede superar ${SLA_NAME_MAX_LENGTH} caracteres.`;

	const code = draft.code.trim();
	if (mode === 'create') {
		if (!code) errors.code = 'El código es obligatorio.';
		else if (code.length < SLA_CODE_MIN_LENGTH || code.length > SLA_CODE_MAX_LENGTH)
			errors.code = `El código debe tener entre ${SLA_CODE_MIN_LENGTH} y ${SLA_CODE_MAX_LENGTH} caracteres.`;
		else if (!SLA_CODE_PATTERN.test(code))
			errors.code =
				'Usa minúsculas, números y guiones bajos, empezando por una letra (ej. soporte_estandar).';
	}

	const description = draft.description.trim();
	if (description.length > SLA_DESCRIPTION_MAX_LENGTH)
		errors.description = `La descripción no puede superar ${SLA_DESCRIPTION_MAX_LENGTH} caracteres.`;

	const firstResponse = toMinutes(draft.firstResponseValue, draft.firstResponseUnit);
	if (!firstResponse.ok) errors.firstResponse = firstResponse.error;
	const resolution = toMinutes(draft.resolutionValue, draft.resolutionUnit);
	if (!resolution.ok) errors.resolution = resolution.error;
	else if (firstResponse.ok && resolution.minutes < firstResponse.minutes)
		errors.resolution = 'La resolución no puede ser menor que la primera respuesta.';

	if (Object.keys(errors).length > 0 || !firstResponse.ok || !resolution.ok)
		return { ok: false, errors };
	// A default policy is always active: deactivating also drops the default flag.
	const active = mode === 'create' ? true : draft.active;
	return {
		ok: true,
		value: {
			code,
			name,
			description: description || null,
			firstResponseMinutes: firstResponse.minutes,
			resolutionMinutes: resolution.minutes,
			active,
			isDefault: active && draft.isDefault
		}
	};
}

/** POST body (the API client adds the organization in the query). */
export function toCreateSlaPolicy(value: ValidSlaPolicy) {
	return {
		code: value.code,
		name: value.name,
		description: value.description,
		firstResponseMinutes: value.firstResponseMinutes,
		resolutionMinutes: value.resolutionMinutes,
		isDefault: value.isDefault
	};
}

/** PATCH with only what changed (code never: it is immutable). Empty -> nothing to send. */
export function toSlaPolicyPatch(original: SlaPolicy, value: ValidSlaPolicy): UpdateSlaPolicyPatch {
	const patch: UpdateSlaPolicyPatch = {};
	if (value.name !== original.name) patch.name = value.name;
	if (value.description !== original.description) patch.description = value.description;
	if (value.firstResponseMinutes !== original.firstResponseMinutes)
		patch.firstResponseMinutes = value.firstResponseMinutes;
	if (value.resolutionMinutes !== original.resolutionMinutes)
		patch.resolutionMinutes = value.resolutionMinutes;
	if (value.active !== original.active) patch.active = value.active;
	if (value.isDefault !== original.isDefault) patch.isDefault = value.isDefault;
	return patch;
}

/** Server error codes of /api/sla-policies that belong to one field. */
export function slaPolicyErrorField(code: string): SlaPolicyField | null {
	if (code === 'SLA_POLICY_CODE_CONFLICT') return 'code';
	if (code === 'SLA_POLICY_INVALID_TARGET') return 'resolution';
	return null;
}
