import { and, asc, eq, ne, type SQL } from 'drizzle-orm';
import { slaPolicies, SLA_TARGET_MAX_MINUTES } from '../db/schema';
import { IncidentServiceError, type IncidentDatabase } from './incidents';
import { assertOperationalOrganization } from './roles';

/**
 * SLA policy configuration (5.4T-A). Tenant-scoped CRUD without physical delete (deactivate
 * instead). Targets are 24x7 elapsed minutes. No incident integration here: assigning a policy to
 * incidents, snapshotting targets and computing deadlines belong to 5.4T-B.
 *
 * Default semantics: at most one default per organization (partial unique index) and a default is
 * always active (CHECK). Setting a default unsets the previous one in the same transaction, under
 * the organization row lock (FOR UPDATE) so concurrent switches are serialized. Deactivating the
 * default also clears its default flag (the organization is then left without a default).
 */

export const SLA_POLICY_NAME_MAX_LENGTH = 100;
export const SLA_POLICY_DESCRIPTION_MAX_LENGTH = 1000;
export const SLA_POLICY_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export interface SlaPolicyRecord {
	id: string;
	code: string;
	name: string;
	description: string | null;
	active: boolean;
	isDefault: boolean;
	firstResponseMinutes: number;
	resolutionMinutes: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface CreateSlaPolicyInput {
	code: unknown;
	name: unknown;
	description?: unknown;
	firstResponseMinutes: unknown;
	resolutionMinutes: unknown;
	isDefault?: unknown;
}

export interface UpdateSlaPolicyInput {
	name?: unknown;
	description?: unknown;
	active?: unknown;
	firstResponseMinutes?: unknown;
	resolutionMinutes?: unknown;
	isDefault?: unknown;
}

export interface ListSlaPoliciesFilters {
	active?: boolean;
	isDefault?: boolean;
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const columns = {
	id: slaPolicies.id,
	code: slaPolicies.code,
	name: slaPolicies.name,
	description: slaPolicies.description,
	active: slaPolicies.active,
	isDefault: slaPolicies.isDefault,
	firstResponseMinutes: slaPolicies.firstResponseMinutes,
	resolutionMinutes: slaPolicies.resolutionMinutes,
	createdAt: slaPolicies.createdAt,
	updatedAt: slaPolicies.updatedAt
};

function invalid(message: string): IncidentServiceError {
	return new IncidentServiceError('INVALID_INPUT', message);
}

function invalidTarget(message: string): IncidentServiceError {
	return new IncidentServiceError('SLA_POLICY_INVALID_TARGET', message);
}

function assertUuid(value: unknown, name: string): asserts value is string {
	if (typeof value !== 'string' || !uuidRegex.test(value)) throw invalid(`${name} must be a UUID`);
}

function validateCode(code: unknown): string {
	if (
		typeof code !== 'string' ||
		code.length < 3 ||
		code.length > 50 ||
		!SLA_POLICY_CODE_PATTERN.test(code)
	)
		throw invalid('code must be lowercase snake_case (3-50 characters)');
	return code;
}

function validateName(name: unknown): string {
	if (typeof name !== 'string') throw invalid('name must be a string');
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > SLA_POLICY_NAME_MAX_LENGTH || trimmed.includes('\u0000'))
		throw invalid('invalid name');
	return trimmed;
}

/** Plain text, never interpreted. Empty or whitespace-only becomes null. */
function validateDescription(description: unknown): string | null {
	if (description === null) return null;
	if (typeof description !== 'string') throw invalid('description must be a string or null');
	const trimmed = description.trim();
	if (trimmed.length > SLA_POLICY_DESCRIPTION_MAX_LENGTH || trimmed.includes('\u0000'))
		throw invalid('invalid description');
	return trimmed.length === 0 ? null : trimmed;
}

/** Positive safe integer minutes, 1..SLA_TARGET_MAX_MINUTES (no floats, zero, Infinity, strings). */
function validateMinutes(value: unknown, name: string): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > SLA_TARGET_MAX_MINUTES
	)
		throw invalidTarget(`${name} must be an integer between 1 and ${SLA_TARGET_MAX_MINUTES}`);
	return value;
}

/** A resolution target shorter than the first-response target is contradictory. */
function assertTargetOrder(firstResponseMinutes: number, resolutionMinutes: number) {
	if (resolutionMinutes < firstResponseMinutes)
		throw invalidTarget('resolutionMinutes must be greater than or equal to firstResponseMinutes');
}

function validateBoolean(value: unknown, name: string): boolean {
	if (typeof value !== 'boolean') throw invalid(`${name} must be a boolean`);
	return value;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
	return [error, (error as { cause?: unknown })?.cause].some((candidate) => {
		const {
			code,
			constraint: name,
			constraint_name
		} = (candidate ?? {}) as Record<string, unknown>;
		return code === '23505' && (name ?? constraint_name) === constraint;
	});
}

/** Last-resort guard: the partial unique index rejected a second default (concurrent switch). */
function mapDefaultRace(error: unknown): unknown {
	return isUniqueViolation(error, 'sla_policies_org_default_unique_idx')
		? new IncidentServiceError('SLA_POLICY_INVALID_DEFAULT', 'Another default was set concurrently')
		: error;
}

async function inTransaction<T>(
	db: IncidentDatabase,
	execute: (tx: IncidentDatabase) => Promise<T>
): Promise<T> {
	if ('transaction' in db && typeof db.transaction === 'function')
		return await db.transaction(async (tx) => execute(tx));
	return await execute(db);
}

async function unsetOtherDefaults(
	tx: IncidentDatabase,
	organizationId: string,
	keepId: string | null,
	now: Date
) {
	const conditions: SQL[] = [
		eq(slaPolicies.organizationId, organizationId),
		eq(slaPolicies.isDefault, true)
	];
	if (keepId) conditions.push(ne(slaPolicies.id, keepId));
	await tx
		.update(slaPolicies)
		.set({ isDefault: false, updatedAt: now })
		.where(and(...conditions));
}

/** Organization policies ordered by code (unique per tenant, so deterministic). sla:view. */
export async function listSlaPolicies(
	db: IncidentDatabase,
	organizationId: string,
	filters: ListSlaPoliciesFilters = {}
): Promise<SlaPolicyRecord[]> {
	assertUuid(organizationId, 'organizationId');
	const conditions: SQL[] = [eq(slaPolicies.organizationId, organizationId)];
	if (filters.active !== undefined)
		conditions.push(eq(slaPolicies.active, validateBoolean(filters.active, 'active')));
	if (filters.isDefault !== undefined)
		conditions.push(eq(slaPolicies.isDefault, validateBoolean(filters.isDefault, 'isDefault')));
	return db
		.select(columns)
		.from(slaPolicies)
		.where(and(...conditions))
		.orderBy(asc(slaPolicies.code), asc(slaPolicies.id));
}

/** Another tenant's policy is indistinguishable from a missing one. Inactive ones are readable. */
export async function getSlaPolicy(
	db: IncidentDatabase,
	organizationId: string,
	policyId: string
): Promise<SlaPolicyRecord> {
	assertUuid(organizationId, 'organizationId');
	assertUuid(policyId, 'policyId');
	const [row] = await db
		.select(columns)
		.from(slaPolicies)
		.where(and(eq(slaPolicies.id, policyId), eq(slaPolicies.organizationId, organizationId)))
		.limit(1);
	if (!row) throw new IncidentServiceError('SLA_POLICY_NOT_FOUND', 'SLA policy not found');
	return row;
}

/**
 * Creates an active policy (a new policy can never start inactive). Code is tenant-unique and
 * immutable afterwards. With isDefault = true the previous default is unset atomically.
 */
export async function createSlaPolicy(
	db: IncidentDatabase,
	organizationId: string,
	input: CreateSlaPolicyInput
): Promise<SlaPolicyRecord> {
	assertUuid(organizationId, 'organizationId');
	if (!input || typeof input !== 'object') throw invalid('invalid SLA policy input');
	const code = validateCode(input.code);
	const name = validateName(input.name);
	const description =
		input.description === undefined ? null : validateDescription(input.description);
	const firstResponseMinutes = validateMinutes(input.firstResponseMinutes, 'firstResponseMinutes');
	const resolutionMinutes = validateMinutes(input.resolutionMinutes, 'resolutionMinutes');
	assertTargetOrder(firstResponseMinutes, resolutionMinutes);
	const isDefault =
		input.isDefault === undefined ? false : validateBoolean(input.isDefault, 'isDefault');
	try {
		return await inTransaction(db, async (tx) => {
			await assertOperationalOrganization(tx, organizationId, 'update');
			const now = new Date();
			if (isDefault) await unsetOtherDefaults(tx, organizationId, null, now);
			const [created] = await tx
				.insert(slaPolicies)
				.values({
					organizationId,
					code,
					name,
					description,
					active: true,
					isDefault,
					firstResponseMinutes,
					resolutionMinutes,
					createdAt: now,
					updatedAt: now
				})
				.returning(columns);
			return created;
		});
	} catch (error) {
		if (isUniqueViolation(error, 'sla_policies_org_code_unique'))
			throw new IncidentServiceError(
				'SLA_POLICY_CODE_CONFLICT',
				'An SLA policy with this code already exists'
			);
		throw mapDefaultRace(error);
	}
}

/**
 * Partial update (name, description, active, targets, isDefault; code is immutable).
 * - Targets are validated against the resulting pair (partial updates included).
 * - isDefault = true requires the resulting policy to be active (SLA_POLICY_INVALID_DEFAULT) and
 *   unsets the previous default atomically.
 * - active = false on the default also clears isDefault (never an inactive default).
 */
export async function updateSlaPolicy(
	db: IncidentDatabase,
	organizationId: string,
	policyId: string,
	input: UpdateSlaPolicyInput
): Promise<SlaPolicyRecord> {
	assertUuid(organizationId, 'organizationId');
	assertUuid(policyId, 'policyId');
	if (
		!input ||
		typeof input !== 'object' ||
		(input.name === undefined &&
			input.description === undefined &&
			input.active === undefined &&
			input.firstResponseMinutes === undefined &&
			input.resolutionMinutes === undefined &&
			input.isDefault === undefined)
	)
		throw invalid('at least one field is required');
	const name = input.name === undefined ? undefined : validateName(input.name);
	const description =
		input.description === undefined ? undefined : validateDescription(input.description);
	const active = input.active === undefined ? undefined : validateBoolean(input.active, 'active');
	const firstResponse =
		input.firstResponseMinutes === undefined
			? undefined
			: validateMinutes(input.firstResponseMinutes, 'firstResponseMinutes');
	const resolution =
		input.resolutionMinutes === undefined
			? undefined
			: validateMinutes(input.resolutionMinutes, 'resolutionMinutes');
	const isDefault =
		input.isDefault === undefined ? undefined : validateBoolean(input.isDefault, 'isDefault');

	try {
		return await inTransaction(db, async (tx) => {
			await assertOperationalOrganization(tx, organizationId, 'update');
			const [current] = await tx
				.select(columns)
				.from(slaPolicies)
				.where(and(eq(slaPolicies.id, policyId), eq(slaPolicies.organizationId, organizationId)))
				.limit(1)
				.for('update');
			if (!current) throw new IncidentServiceError('SLA_POLICY_NOT_FOUND', 'SLA policy not found');
			const nextFirst = firstResponse ?? current.firstResponseMinutes;
			const nextResolution = resolution ?? current.resolutionMinutes;
			assertTargetOrder(nextFirst, nextResolution);
			const nextActive = active ?? current.active;
			let nextDefault = isDefault ?? current.isDefault;
			if (isDefault === true && !nextActive)
				throw new IncidentServiceError(
					'SLA_POLICY_INVALID_DEFAULT',
					'An inactive SLA policy cannot be the default'
				);
			if (!nextActive) nextDefault = false;
			const now = new Date();
			if (nextDefault && !current.isDefault)
				await unsetOtherDefaults(tx, organizationId, policyId, now);
			const [updated] = await tx
				.update(slaPolicies)
				.set({
					...(name !== undefined ? { name } : {}),
					...(description !== undefined ? { description } : {}),
					active: nextActive,
					isDefault: nextDefault,
					firstResponseMinutes: nextFirst,
					resolutionMinutes: nextResolution,
					updatedAt: now
				})
				.where(and(eq(slaPolicies.id, policyId), eq(slaPolicies.organizationId, organizationId)))
				.returning(columns);
			return updated;
		});
	} catch (error) {
		throw mapDefaultRace(error);
	}
}
