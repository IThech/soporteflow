import { isAutomationEventType, type AutomationEventType } from './events';

export class AutomationRuleError extends Error {
	constructor(readonly code: 'INVALID_INPUT' | 'RULE_NOT_FOUND' | 'RULE_LIMIT_REACHED') {
		super(code);
		this.name = 'AutomationRuleError';
	}
}
const invalid = () => new AutomationRuleError('INVALID_INPUT');
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validId(v: unknown): asserts v is string {
	if (typeof v !== 'string' || !uuid.test(v)) throw invalid();
}
type Field = {
	kind: 'uuid' | 'enum' | 'number' | 'date';
	values?: readonly string[];
	nullable?: boolean;
};
const id: Field = { kind: 'uuid' },
	optionalId: Field = { kind: 'uuid', nullable: true };
const status: Field = { kind: 'enum', values: ['open', 'pending', 'resolved', 'closed'] };
const priority: Field = { kind: 'enum', values: ['low', 'medium', 'high', 'urgent'] };
const level: Field = { kind: 'enum', values: ['N1', 'N2', 'N3'] };
const sla = {
	slaPolicyId: id,
	dueAt: { kind: 'date' } as Field,
	achievedAt: { kind: 'date' } as Field,
	observedBy: { kind: 'enum', values: ['action'] } as Field
};
export const CONDITION_FIELDS: Record<AutomationEventType, Record<string, Field>> = {
	'incident.created': {
		status,
		priority,
		supportLevel: level,
		requesterUserId: optionalId,
		categoryId: optionalId,
		siteId: optionalId,
		slaPolicyId: optionalId
	},
	'incident.assigned': { previousAssigneeUserId: optionalId, assignedToUserId: id },
	'incident.unassigned': { previousAssigneeUserId: id },
	'incident.team_changed': { previousTeamId: optionalId, newTeamId: optionalId },
	'incident.status_changed': { previousStatus: status, newStatus: status },
	'incident.reopened': {
		previousStatus: { kind: 'enum', values: ['resolved', 'closed'] },
		newStatus: { kind: 'enum', values: ['open'] }
	},
	'incident.priority_changed': { previousPriority: priority, newPriority: priority },
	'incident.category_changed': { previousCategoryId: optionalId, newCategoryId: optionalId },
	'incident.site_changed': { previousSiteId: optionalId, newSiteId: optionalId },
	'incident.support_level_changed': { previousSupportLevel: level, newSupportLevel: level },
	'incident.public_comment_added': { messageId: id },
	'incident.internal_note_added': { messageId: id },
	'sla.first_response_met': sla,
	'sla.first_response_breached': sla,
	'sla.resolution_met': sla,
	'sla.resolution_breached': sla
};
type Scalar = string | number | null;
export interface Condition {
	field: string;
	operator: 'eq' | 'neq' | 'in' | 'not_in' | 'is_null' | 'is_not_null';
	value?: Scalar | Scalar[];
}
export interface Conditions {
	all: Condition[];
}
export type Action =
	| { type: 'incident.assign_user'; userId: string | null }
	| { type: 'incident.assign_team'; teamId: string | null }
	| { type: 'incident.set_priority'; priority: 'low' | 'medium' | 'high' | 'urgent' }
	| { type: 'incident.set_support_level'; supportLevel: 'N1' | 'N2' | 'N3' }
	| { type: 'incident.set_status'; status: 'open' | 'pending' | 'resolved' | 'closed' }
	| { type: 'incident.set_category'; categoryId: string | null }
	| { type: 'incident.set_site'; siteId: string | null }
	| { type: 'incident.add_internal_note'; text: string };
export interface RuleInput {
	name: string;
	active: boolean;
	eventType: AutomationEventType;
	conditions: Conditions;
	actions: Action[];
	sortOrder: number;
}
function object(v: unknown): Record<string, unknown> {
	if (
		!v ||
		typeof v !== 'object' ||
		Array.isArray(v) ||
		Object.getPrototypeOf(v) !== Object.prototype
	)
		throw invalid();
	return v as Record<string, unknown>;
}
function keys(o: Record<string, unknown>, allowed: string[]) {
	if (Object.keys(o).some((k) => !allowed.includes(k))) throw invalid();
}
function matches(field: Field, v: unknown): boolean {
	if (v === null) return field.nullable === true;
	if (field.kind === 'uuid') return typeof v === 'string' && uuid.test(v);
	if (field.kind === 'enum') return typeof v === 'string' && !!field.values?.includes(v);
	if (field.kind === 'number') return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
	return (
		typeof v === 'string' &&
		/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
		Number.isFinite(Date.parse(v)) &&
		new Date(v).toISOString() === v
	);
}
function fieldFor(eventType: AutomationEventType, key: unknown): Field {
	if (typeof key !== 'string' || !key.startsWith('payload.')) throw invalid();
	const name = key.slice(8);
	const fields = {
		incidentId: id,
		incidentNumber: { kind: 'number' } as Field,
		...CONDITION_FIELDS[eventType]
	};
	if (!Object.hasOwn(fields, name)) throw invalid();
	return fields[name as keyof typeof fields];
}
export function validateConditions(eventType: AutomationEventType, value: unknown): Conditions {
	const o = object(value);
	keys(o, ['all']);
	if (!Array.isArray(o.all) || o.all.length > 20) throw invalid();
	return {
		all: o.all.map((v) => {
			const c = object(v);
			keys(c, ['field', 'operator', 'value']);
			const f = fieldFor(eventType, c.field);
			if (!['eq', 'neq', 'in', 'not_in', 'is_null', 'is_not_null'].includes(String(c.operator)))
				throw invalid();
			if (c.operator === 'is_null' || c.operator === 'is_not_null') {
				if (!f.nullable || Object.hasOwn(c, 'value')) throw invalid();
			} else if (c.operator === 'in' || c.operator === 'not_in') {
				if (
					!Array.isArray(c.value) ||
					!c.value.length ||
					c.value.length > 20 ||
					!c.value.every((v) => matches(f, v))
				)
					throw invalid();
			} else if (!Object.hasOwn(c, 'value') || !matches(f, c.value)) throw invalid();
			return { ...c } as unknown as Condition;
		})
	};
}
export function evaluateConditions(
	eventType: AutomationEventType,
	conditions: Conditions,
	payload: Record<string, unknown>
): boolean {
	return conditions.all.every((c) => {
		const key = c.field.slice(8),
			f = fieldFor(eventType, c.field);
		if (!Object.hasOwn(payload, key) || !matches(f, payload[key])) return false;
		const v = payload[key];
		switch (c.operator) {
			case 'eq':
				return v === c.value;
			case 'neq':
				return v !== c.value;
			case 'in':
				return (c.value as Scalar[]).includes(v as Scalar);
			case 'not_in':
				return !(c.value as Scalar[]).includes(v as Scalar);
			case 'is_null':
				return v === null;
			case 'is_not_null':
				return v !== null;
		}
	});
}
const actionFields: Record<Action['type'], { key: string; field?: Field }> = {
	'incident.assign_user': { key: 'userId', field: optionalId },
	'incident.assign_team': { key: 'teamId', field: optionalId },
	'incident.set_priority': { key: 'priority', field: priority },
	'incident.set_support_level': { key: 'supportLevel', field: level },
	'incident.set_status': { key: 'status', field: status },
	'incident.set_category': { key: 'categoryId', field: optionalId },
	'incident.set_site': { key: 'siteId', field: optionalId },
	'incident.add_internal_note': { key: 'text' }
};
export function validateActions(value: unknown): Action[] {
	if (!Array.isArray(value) || !value.length || value.length > 10) throw invalid();
	return value.map((v) => {
		const o = object(v);
		if (typeof o.type !== 'string' || !Object.hasOwn(actionFields, o.type)) throw invalid();
		const spec = actionFields[o.type as Action['type']];
		keys(o, ['type', spec.key]);
		if (spec.field) {
			if (!matches(spec.field, o[spec.key])) throw invalid();
		} else if (
			typeof o.text !== 'string' ||
			!o.text.trim() ||
			o.text.length > 1000 ||
			/[<>]/.test(o.text) ||
			o.text.includes('\u0000') ||
			o.text.includes('{{') ||
			o.text.includes('}}')
		)
			throw invalid();
		return { ...o } as Action;
	});
}
export function parseRule(value: unknown, current?: RuleInput): RuleInput {
	const o = object(value);
	keys(o, ['name', 'active', 'eventType', 'conditions', 'actions', 'sortOrder']);
	if (current && Object.keys(o).length === 0) throw invalid();
	const r = { active: true, sortOrder: 0, ...current, ...o };
	if (
		typeof r.name !== 'string' ||
		!r.name.trim() ||
		r.name.length > 120 ||
		r.name.includes('\u0000')
	)
		throw invalid();
	if (
		typeof r.active !== 'boolean' ||
		!isAutomationEventType(r.eventType) ||
		!Number.isInteger(r.sortOrder) ||
		Number(r.sortOrder) < -10000 ||
		Number(r.sortOrder) > 10000
	)
		throw invalid();
	return {
		name: r.name.trim(),
		active: r.active,
		eventType: r.eventType,
		sortOrder: Number(r.sortOrder),
		conditions: validateConditions(r.eventType, r.conditions),
		actions: validateActions(r.actions)
	};
}
