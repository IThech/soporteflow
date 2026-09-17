import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

/**
 * Thrown when server code attempts to access the database without DATABASE_URL configured.
 * This distinguishes missing configuration from real infrastructure / connection failures.
 */
export class DatabaseConfigurationError extends Error {
	constructor(
		message = 'DATABASE_URL no está configurada en las variables de entorno del servidor.'
	) {
		super(message);
		this.name = 'DatabaseConfigurationError';
	}
}

let client: postgres.Sql | null = null;
let dbInstance: PostgresJsDatabase<typeof schema> | null = null;

/**
 * Returns the active Drizzle database client instance.
 * Lazily initialized to allow SvelteKit to build and run in client-only/demo mode without requiring a running database.
 * If DATABASE_URL is not configured, throws DatabaseConfigurationError.
 * If PostgreSQL fails to connect or a query fails, the real infrastructure exception is propagated without modification.
 */
export function getDb(): PostgresJsDatabase<typeof schema> {
	if (dbInstance) {
		return dbInstance;
	}

	const connectionString = env.DATABASE_URL || process.env.DATABASE_URL;
	if (!connectionString || !connectionString.trim()) {
		throw new DatabaseConfigurationError();
	}

	client = postgres(connectionString, {
		max: 10,
		idle_timeout: 20,
		connect_timeout: 10
	});

	dbInstance = drizzle(client, { schema });
	return dbInstance;
}

/**
 * Server database proxy.
 * Calls getDb() upon execution, ensuring lazy initialization and proper error propagation.
 */
export const db = new Proxy({} as PostgresJsDatabase<typeof schema>, {
	get(_target, prop, receiver) {
		const instance = getDb();
		const value = Reflect.get(instance, prop, receiver);
		return typeof value === 'function' ? value.bind(instance) : value;
	}
});

export * from './schema';
export * from './types';
