import { boundedRows } from '../security/bounded-read';
import { and, asc, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { organizations, clients } from '../db/schema';
import { IncidentServiceError } from './incidents';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClientDatabase = PgDatabase<any, any>;

/** Client DTO: organizationId is implied by the tenant-scoped query and never returned. */
export interface ClientRecord {
	id: string;
	name: string;
	description: string | null;
	active: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export const CLIENT_NAME_MIN_LENGTH = 2;
export const CLIENT_NAME_MAX_LENGTH = 255;

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(value: unknown): value is string {
	return typeof value === 'string' && uuidRegex.test(value);
}

const clientColumns = {
	id: clients.id,
	name: clients.name,
	description: clients.description,
	active: clients.active,
	createdAt: clients.createdAt,
	updatedAt: clients.updatedAt
};

/** Display form stored in the database: trimmed, inner whitespace collapsed to one space. */
export function canonicalClientName(name: string): string {
	return name.trim().replace(/\s+/g, ' ');
}

/** Comparison key mirroring clients_org_normalized_name_unique_idx (case and spacing insensitive). */
export function normalizeClientName(name: string): string {
	return canonicalClientName(name).toLowerCase();
}

function validateName(name: unknown): string {
	if (typeof name !== 'string') {
		throw new IncidentServiceError('INVALID_INPUT', 'name must be a string');
	}
	const canonical = canonicalClientName(name);
	if (canonical.length < CLIENT_NAME_MIN_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`name must have at least ${CLIENT_NAME_MIN_LENGTH} characters`
		);
	}
	if (canonical.length > CLIENT_NAME_MAX_LENGTH) {
		throw new IncidentServiceError(
			'INVALID_INPUT',
			`name must not exceed ${CLIENT_NAME_MAX_LENGTH} characters`
		);
	}
	if (canonical.includes('\u0000')) {
		throw new IncidentServiceError('INVALID_INPUT', 'name contains invalid characters');
	}
	return canonical;
}

function validateIds(organizationId: unknown, clientId?: unknown): void {
	if (!isValidUuid(organizationId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'organizationId must be a valid UUID');
	}
	if (clientId !== undefined && !isValidUuid(clientId)) {
		throw new IncidentServiceError('INVALID_INPUT', 'clientId must be a valid UUID');
	}
}

function clientNotFound(): IncidentServiceError {
	return new IncidentServiceError('CLIENT_NOT_FOUND', 'Client not found');
}

/** Maps the database unique violation to a domain error; the constraint is the source of truth. */
function isDuplicateNameViolation(error: unknown): boolean {
	const candidates = [error, (error as { cause?: unknown })?.cause];
	return candidates.some((candidate) => {
		const { code, constraint, constraint_name } = (candidate ?? {}) as Record<string, unknown>;
		const name = constraint ?? constraint_name;
		return (
			code === '23505' &&
			(name === undefined ||
				name === 'clients_org_normalized_name_unique_idx' ||
				name === 'clients_org_name_unique')
		);
	});
}

async function assertOperationalOrganization(
	tx: ClientDatabase,
	organizationId: string
): Promise<void> {
	const [org] = await tx
		.select({ status: organizations.status })
		.from(organizations)
		.where(eq(organizations.id, organizationId))
		.limit(1);
	if (!org) {
		throw new IncidentServiceError('ORGANIZATION_NOT_FOUND', 'Organization does not exist');
	}
	if (org.status !== 'active') {
		throw new IncidentServiceError(
			'ORGANIZATION_NOT_OPERATIONAL',
			`Organization is not operational (status: '${org.status}')`
		);
	}
}

async function inTransaction<T>(
	dbOrTx: ClientDatabase,
	execute: (tx: ClientDatabase) => Promise<T>
): Promise<T> {
	try {
		if ('transaction' in dbOrTx && typeof dbOrTx.transaction === 'function') {
			return await dbOrTx.transaction(async (tx) => execute(tx));
		}
		return await execute(dbOrTx);
	} catch (error) {
		if (error instanceof IncidentServiceError) throw error;
		if (isDuplicateNameViolation(error)) {
			throw new IncidentServiceError(
				'CLIENT_NAME_DUPLICATE',
				'A client with this name already exists in the organization'
			);
		}
		throw error;
	}
}

/**
 * Lists the clients of one organization, including inactive ones for management.
 * Pass { activeOnly: true } to list only clients selectable for new incidents.
 * Deterministic ordering: name ASC, id ASC.
 */
export async function listClients(
	db: ClientDatabase,
	organizationId: string,
	options: { activeOnly?: boolean } = {}
): Promise<ClientRecord[]> {
	validateIds(organizationId);
	const conditions = [eq(clients.organizationId, organizationId)];
	if (options.activeOnly === true) conditions.push(eq(clients.active, true));
	return boundedRows(
		db
			.select(clientColumns)
			.from(clients)
			.where(and(...conditions))
			.orderBy(asc(clients.name), asc(clients.id))
	);
}

/**
 * Gets a single client by id and organizationId.
 * Missing and cross-tenant clients both return CLIENT_NOT_FOUND.
 */
export async function getClient(
	db: ClientDatabase,
	organizationId: string,
	clientId: string
): Promise<ClientRecord> {
	validateIds(organizationId, clientId);
	const [client] = await db
		.select(clientColumns)
		.from(clients)
		.where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)))
		.limit(1);
	if (!client) throw clientNotFound();
	return client;
}

/**
 * Creates an active client. Duplicate names (case and spacing insensitive) within the same
 * organization are rejected by the unique index.
 */
export async function createClient(
	dbOrTx: ClientDatabase,
	organizationId: string,
	input: { name: unknown; description?: unknown }
): Promise<ClientRecord> {
	validateIds(organizationId);
	const name = validateName(input?.name);
	let description: string | null = null;
	if (input?.description !== undefined && input?.description !== null) {
		if (typeof input.description !== 'string') {
			throw new IncidentServiceError('INVALID_INPUT', 'description must be a string');
		}
		description = input.description.trim() || null;
	}
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId);
		const [client] = await tx
			.insert(clients)
			.values({ organizationId, name, description, active: true })
			.returning(clientColumns);
		return client;
	});
}

/** Renames or updates a client of the organization. Does not change its active state. */
export async function updateClient(
	dbOrTx: ClientDatabase,
	organizationId: string,
	clientId: string,
	input: { name?: unknown; description?: unknown }
): Promise<ClientRecord> {
	validateIds(organizationId, clientId);
	const updates: { name?: string; description?: string | null; updatedAt: Date } = {
		updatedAt: new Date()
	};
	if (input?.name !== undefined) {
		updates.name = validateName(input.name);
	}
	if (input?.description !== undefined) {
		if (input.description === null) {
			updates.description = null;
		} else if (typeof input.description !== 'string') {
			throw new IncidentServiceError('INVALID_INPUT', 'description must be a string');
		} else {
			updates.description = input.description.trim() || null;
		}
	}
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId);
		const [client] = await tx
			.update(clients)
			.set(updates)
			.where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)))
			.returning(clientColumns);
		if (!client) throw clientNotFound();
		return client;
	});
}

/**
 * Activates or deactivates a client. Deactivation never deletes: historical incidents keep
 * pointing to the client, while new associations reject inactive clients.
 */
export async function setClientActive(
	dbOrTx: ClientDatabase,
	organizationId: string,
	clientId: string,
	active: boolean
): Promise<ClientRecord> {
	validateIds(organizationId, clientId);
	if (typeof active !== 'boolean') {
		throw new IncidentServiceError('INVALID_INPUT', 'active must be a boolean');
	}
	return inTransaction(dbOrTx, async (tx) => {
		await assertOperationalOrganization(tx, organizationId);
		const [client] = await tx
			.update(clients)
			.set({ active, updatedAt: new Date() })
			.where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)))
			.returning(clientColumns);
		if (!client) throw clientNotFound();
		return client;
	});
}

/**
 * Validates a client for a new incident inside the caller's transaction.
 * Scoped by id AND organization, FOR SHARE against a concurrent UPDATE clients SET active = false.
 * Missing and cross-tenant clients are indistinguishable (CLIENT_NOT_FOUND); inactive ones raise CLIENT_INACTIVE.
 */
export async function lockActiveClient(
	tx: ClientDatabase,
	organizationId: string,
	clientId: string
): Promise<{ id: string; name: string }> {
	const [client] = await tx
		.select({ id: clients.id, name: clients.name, active: clients.active })
		.from(clients)
		.where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)))
		.limit(1)
		.for('share');
	if (!client) {
		throw new IncidentServiceError('CLIENT_NOT_FOUND', 'Client not found');
	}
	if (!client.active) {
		throw new IncidentServiceError('CLIENT_INACTIVE', 'Client is inactive');
	}
	return { id: client.id, name: client.name };
}
