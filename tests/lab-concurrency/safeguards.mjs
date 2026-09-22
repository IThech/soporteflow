import { loadPackage } from './module-loader.mjs';
import { REQUIRED_CATALOG_PERMISSIONS } from './fixtures.mjs';

const postgresModule = await loadPackage('postgres');
const postgres = postgresModule.default || postgresModule;

/**
 * Authorized static lab constants.
 * Hardcoded to prevent connecting to any unauthorized database, user, or remote socket.
 */
export const AUTHORIZED_LAB_DATABASE = 'soporteflow_concurrency_lab';
export const AUTHORIZED_LAB_USER = 'soporteflow_lab_runner';
export const AUTHORIZED_LAB_SOCKET = '/var/run/postgresql';

/**
 * Fatal security error raised when any mandatory environment invariant fails.
 * Halts execution immediately before any write or fixture creation can occur.
 */
export class LabSecurityError extends Error {
	constructor(message) {
		super(`[LAB SECURITY INVARIANT FAILED] ${message}`);
		this.name = 'LabSecurityError';
	}
}

/**
 * Expected 21 base tables in SoporteFlow Core v1 (schema 0000 + 0001).
 */
export const EXPECTED_LAB_TABLES = Object.freeze([
	'auth_accounts',
	'auth_sessions',
	'auth_users',
	'auth_verifications',
	'departments',
	'memberships',
	'modules',
	'organization_modules',
	'organizations',
	'permissions',
	'role_assignments',
	'role_permissions',
	'role_template_permissions',
	'role_templates',
	'roles',
	'sites',
	'team_memberships',
	'team_service_departments',
	'teams',
	'user_emails',
	'users'
]);

export { REQUIRED_CATALOG_PERMISSIONS };

/**
 * Detects whether a SQL query string or template represents a modifying write statement.
 *
 * @param {string} sqlText
 * @returns {boolean}
 */
export function isWriteQuery(sqlText) {
	if (!sqlText || typeof sqlText !== 'string') return false;
	return /^\s*(insert|update|delete|create|drop|alter|truncate)\b/i.test(sqlText.trim());
}

/**
 * Verifies all security invariants on a specific, individual PostgreSQL connection.
 * Every connection used by the lab must pass this verification.
 *
 * Checks:
 * 1. current_database() === 'soporteflow_concurrency_lab'
 * 2. current_user === 'soporteflow_lab_runner'
 * 3. Connection is exclusively over local UNIX domain socket (inet_server_addr IS NULL)
 * 4. User is non-superuser and has no administrative privileges
 * 5. Exactly 21 expected tables exist
 * 6. Sets strict safety timeouts (lock_timeout, statement_timeout, idle timeout)
 *
 * @param {import('postgres').Sql} sql - Single connection client to verify
 * @param {Object} [existingIdent] - Pre-fetched identification row
 */
export async function verifyConnectionInvariants(sql, existingIdent = null) {
	// 1. Check current database, user, and socket transport on THIS specific connection
	const ident =
		existingIdent ||
		(
			await sql`
		SELECT
			current_database() AS db,
			current_user AS usr,
			inet_server_addr() AS srv_addr,
			inet_client_addr() AS clt_addr,
			pg_backend_pid() AS pid
	`
		)[0];

	if (!ident || ident.db !== AUTHORIZED_LAB_DATABASE) {
		throw new LabSecurityError(
			`Target database is '${ident?.db}', expected strictly '${AUTHORIZED_LAB_DATABASE}'. Aborting.`
		);
	}

	if (ident.usr !== AUTHORIZED_LAB_USER) {
		throw new LabSecurityError(
			`Connected user is '${ident?.usr}', expected strictly '${AUTHORIZED_LAB_USER}'. Aborting.`
		);
	}

	// In PostgreSQL, unix domain socket connections return NULL for both inet_server_addr and inet_client_addr
	if (ident.srv_addr !== null || ident.clt_addr !== null) {
		throw new LabSecurityError(
			`Connection is over TCP/IP (${ident.srv_addr}:${ident.clt_addr}). Local UNIX domain socket is strictly required. Aborting.`
		);
	}

	// 2. Verify non-privileged account
	const [privs] = await sql`
		SELECT rolsuper, rolcreaterole, rolcreatedb
		FROM pg_roles
		WHERE rolname = current_user
	`;

	if (!privs || privs.rolsuper || privs.rolcreaterole || privs.rolcreatedb) {
		throw new LabSecurityError(
			`Runner account '${ident.usr}' possesses administrative roles (super: ${privs?.rolsuper}, createrole: ${privs?.rolcreaterole}, createdb: ${privs?.rolcreatedb}). Aborting.`
		);
	}

	// 3. Verify all 21 tables are present
	const rows = await sql`
		SELECT table_name
		FROM information_schema.tables
		WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
		ORDER BY table_name
	`;

	const presentTables = rows.map((r) => r.table_name);
	for (const expected of EXPECTED_LAB_TABLES) {
		if (!presentTables.includes(expected)) {
			throw new LabSecurityError(
				`Missing required table '${expected}' in '${AUTHORIZED_LAB_DATABASE}'. Present: [${presentTables.join(', ')}]. Aborting.`
			);
		}
	}

	// 4. Enforce strict safety session timeouts on THIS specific connection
	await sql`SET lock_timeout = '4000ms'`;
	await sql`SET statement_timeout = '6000ms'`;
	await sql`SET idle_in_transaction_session_timeout = '6000ms'`;

	return {
		database: ident.db,
		user: ident.usr,
		isUnixSocket: true,
		pid: ident.pid,
		tablesCount: presentTables.length
	};
}

/**
 * Strictly read-only verification of required catalog permissions.
 * Queries the shared permissions table via SELECT. If any required permission is missing,
 * raises an explicit error and halts execution. Never attempts to insert or modify permissions.
 *
 * @param {import('postgres').Sql} sql - Verified lab connection
 * @returns {Promise<{ verified: boolean, requiredPermissions: readonly string[] }>}
 */
export async function verifyRequiredCatalogPermissions(sql) {
	const rows = await sql`
		SELECT id FROM permissions WHERE id = ANY(${REQUIRED_CATALOG_PERMISSIONS})
	`;

	const present = new Set(rows.map((r) => r.id));
	const missing = REQUIRED_CATALOG_PERMISSIONS.filter((p) => !present.has(p));

	if (missing.length > 0) {
		throw new LabSecurityError(
			`Permisos requeridos ausentes en el catálogo global de permisos: [${missing.join(', ')}]. ` +
				`El ejecutor opera en modo estrictamente de solo lectura sobre el catálogo compartido y ` +
				`no realiza inserciones automáticas. Aplique las migraciones o seeds del catálogo en ` +
				`'soporteflow_concurrency_lab' y solicite autorización antes de ejecutar.`
		);
	}

	return {
		verified: true,
		requiredPermissions: REQUIRED_CATALOG_PERMISSIONS
	};
}

/**
 * Verified Connection Factory.
 * Opens a dedicated single connection (max: 1) to the authorized lab socket.
 * Configures idle_timeout: null to prevent timer-based socket destruction.
 *
 * Architectural note on reconnection audit:
 * - Setting `idle_timeout: null` prevents the driver from closing the socket due to inactivity.
 * - The pre-write proxy hook verifies `pg_backend_pid()` before dispatching mutations or transactions,
 *   catching reconnections that occur between statements and re-applying invariants and session timeouts.
 * - Boundary notice: If a connection drop occurs in-flight during the execution of a statement itself,
 *   the driver's transport-level retry semantics could re-open a physical socket. While PostgreSQL aborts
 *   any open transaction upon connection drop, client-side wrappers cannot claim absolute immunity against
 *   all edge cases without OS/firewall-level socket confinement.
 *
 * @param {Object} [options]
 * @param {string} [options.socketDir] - Must strictly equal AUTHORIZED_LAB_SOCKET
 * @returns {Promise<import('postgres').Sql>}
 */
export async function createVerifiedLabConnection(options = {}) {
	const socketDir = options.socketDir || AUTHORIZED_LAB_SOCKET;

	if (socketDir !== AUTHORIZED_LAB_SOCKET) {
		throw new LabSecurityError(
			`Socket directory '${socketDir}' is unauthorized. Expected strictly '${AUTHORIZED_LAB_SOCKET}'.`
		);
	}

	const rawSql = postgres({
		host: AUTHORIZED_LAB_SOCKET,
		database: AUTHORIZED_LAB_DATABASE,
		user: AUTHORIZED_LAB_USER,
		max: 1, // Single physical connection per instance
		idle_timeout: null, // Disable timer-based socket teardown
		max_lifetime: null, // Disable lifetime-based socket recycling
		connect_timeout: 5
	});

	let verifiedPid = null;

	/**
	 * Guarantees that the active physical connection is verified before any write executes.
	 * If postgres.js reconnected due to socket reset, this hook intercepts
	 * the new physical connection, re-verifies invariants, and re-applies session timeouts.
	 */
	async function ensureVerified() {
		const [ident] = await rawSql`
			SELECT
				current_database() AS db,
				current_user AS usr,
				inet_server_addr() AS srv_addr,
				inet_client_addr() AS clt_addr,
				pg_backend_pid() AS pid
		`;

		if (ident.pid !== verifiedPid) {
			await verifyConnectionInvariants(rawSql, ident);
			verifiedPid = ident.pid;
		}
	}

	try {
		await ensureVerified();
	} catch (err) {
		await rawSql.end({ timeout: 1 }).catch(() => {});
		throw err;
	}

	function wrapQueryIfWrite(query, sqlText) {
		if (!isWriteQuery(sqlText)) {
			return query;
		}

		const originalThen = query.then.bind(query);
		query.then = function (onfulfilled, onrejected) {
			return ensureVerified().then(() => originalThen(onfulfilled, onrejected), onrejected);
		};

		const originalExecute = query.execute?.bind(query);
		if (originalExecute) {
			query.execute = function () {
				ensureVerified()
					.then(() => originalExecute())
					.catch((err) => {
						query.reject?.(err);
					});
				return query;
			};
		}

		return query;
	}

	const proxy = new Proxy(rawSql, {
		apply(target, thisArg, args) {
			const query = Reflect.apply(target, thisArg, args);
			let sqlText = '';
			if (Array.isArray(args[0]?.raw)) {
				sqlText = args[0].raw.join(' ');
			} else if (typeof args[0] === 'string') {
				sqlText = args[0];
			}
			return wrapQueryIfWrite(query, sqlText);
		},
		get(target, prop, receiver) {
			if (prop === 'unsafe') {
				return function (queryStr, ...rest) {
					const query = target.unsafe(queryStr, ...rest);
					return wrapQueryIfWrite(query, typeof queryStr === 'string' ? queryStr : '');
				};
			}
			if (prop === 'begin') {
				return async function (...beginArgs) {
					await ensureVerified();
					return target.begin(...beginArgs);
				};
			}
			const val = Reflect.get(target, prop, receiver);
			return typeof val === 'function' ? val.bind(target) : val;
		}
	});

	return proxy;
}
