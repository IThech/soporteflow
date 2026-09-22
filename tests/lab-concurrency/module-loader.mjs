import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { SYNTHETIC_SECRET } from './fixtures.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Candidate search paths for locating installed node_modules and dependencies.
 * In CT 105, code is in /opt/soporteflow-lab/src and dependencies are in /opt/soporteflow-lab/runner/node_modules.
 * Node.js ESM does NOT use NODE_PATH for bare specifiers; this custom resolver guarantees
 * resolution across local development and CT 105 runner environments.
 */
const candidateSearchPaths = [
	path.resolve(__dirname, '../..'),
	'/opt/soporteflow-lab/runner',
	'/opt/soporteflow-lab/src',
	'/opt/soporteflow-lab',
	...(process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [])
].filter(Boolean);

const requireResolvers = [
	createRequire(import.meta.url),
	...candidateSearchPaths
		.map((p) => {
			try {
				return createRequire(path.join(p, 'package.json'));
			} catch {
				return null;
			}
		})
		.filter(Boolean)
];

/**
 * Resolves a module specifier to its concrete file path using candidate search paths.
 * Supports bare specifiers, subpath exports (e.g. 'better-auth/crypto'), and fallback search.
 *
 * @param {string} specifier - Module or package name to resolve
 * @returns {string} Absolute path to module entry point
 */
export function resolveModulePath(specifier) {
	for (const req of requireResolvers) {
		try {
			return req.resolve(specifier, { paths: candidateSearchPaths });
		} catch {
			// Continue to next candidate
		}
		try {
			return req.resolve(specifier);
		} catch {
			// Continue to next candidate
		}
	}

	for (const base of candidateSearchPaths) {
		const directNodeModules = path.join(base, 'node_modules', specifier);
		if (fs.existsSync(directNodeModules)) {
			const pkgJson = path.join(directNodeModules, 'package.json');
			if (fs.existsSync(pkgJson)) {
				try {
					const req = createRequire(pkgJson);
					return req.resolve(specifier);
				} catch {
					// Fall through
				}
			}
		}
	}

	throw new Error(
		`[MODULE LOADER] Unable to resolve package '${specifier}'. Checked search paths: ${candidateSearchPaths.join(', ')}`
	);
}

/**
 * Dynamically loads an ECMAScript module from resolved physical location.
 *
 * @param {string} specifier - Package specifier
 * @returns {Promise<any>} Loaded ES module namespace
 */
export async function loadPackage(specifier) {
	const resolved = resolveModulePath(specifier);
	return await import(pathToFileURL(resolved).href);
}

// Dynamically load all required external libraries without relying on NODE_PATH in ESM
const tsModule = await loadPackage('typescript');
const ts = tsModule.default || tsModule;

export const orm = await loadPackage('drizzle-orm');
export const pgCore = await loadPackage('drizzle-orm/pg-core');
export const { drizzle } = await loadPackage('drizzle-orm/postgres-js');
export const { betterAuth } = await loadPackage('better-auth');
export const { APIError, createAuthMiddleware } = await loadPackage('better-auth/api');
export const { drizzleAdapter } = await loadPackage('better-auth/adapters/drizzle');
export const { hashPassword, verifyPassword } = await loadPackage('better-auth/crypto');

/**
 * Resolves the root directory containing SoporteFlow source code.
 * Seamlessly handles both local development and CT 105 (/opt/soporteflow-lab/src).
 */
function resolveProjectRoot() {
	const candidates = [path.resolve(__dirname, '../..'), '/opt/soporteflow-lab/src', process.cwd()];

	for (const cand of candidates) {
		if (
			fs.existsSync(path.join(cand, 'src/lib/server/db/schema/identity.ts')) ||
			fs.existsSync(path.join(cand, 'lib/server/db/schema/identity.ts'))
		) {
			return cand;
		}
	}
	return path.resolve(__dirname, '../..');
}

export const rootDir = resolveProjectRoot();

/**
 * Returns the path to `src/lib/server` regardless of whether rootDir is the repo root
 * or the src directory directly.
 */
export function getServerDir() {
	if (fs.existsSync(path.join(rootDir, 'src/lib/server'))) {
		return path.join(rootDir, 'src/lib/server');
	}
	if (fs.existsSync(path.join(rootDir, 'lib/server'))) {
		return path.join(rootDir, 'lib/server');
	}
	return path.join(rootDir, 'src/lib/server');
}

/**
 * Transpiles and loads a TypeScript source file into an isolated VM context.
 */
function transpileAndLoad(filePath, imports) {
	const source = fs.readFileSync(filePath, 'utf8');
	const transpiled = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022
		}
	}).outputText;

	const module = { exports: {} };
	vm.runInNewContext(
		transpiled,
		{
			module,
			exports: module.exports,
			Headers,
			URL,
			process: { env: {} },
			require(key) {
				if (!Object.hasOwn(imports, key)) {
					throw new Error(`[LOADER ERROR] Unexpected import key '${key}' in ${filePath}`);
				}
				return imports[key];
			}
		},
		{ timeout: 5000 }
	);

	return module.exports;
}

/**
 * Loads the complete Drizzle schema from src/lib/server/db/schema/index.ts,
 * properly passing drizzle-orm and drizzle-orm/pg-core from their respective packages.
 */
export function loadLabSchema() {
	const schemaDir = path.join(getServerDir(), 'db/schema');

	const identity = transpileAndLoad(path.join(schemaDir, 'identity.ts'), {
		'drizzle-orm': orm,
		'drizzle-orm/pg-core': pgCore
	});

	const structure = transpileAndLoad(path.join(schemaDir, 'structure.ts'), {
		'drizzle-orm': orm,
		'drizzle-orm/pg-core': pgCore,
		'./identity': identity
	});

	const auth = transpileAndLoad(path.join(schemaDir, 'auth.ts'), {
		'drizzle-orm': orm,
		'drizzle-orm/pg-core': pgCore,
		'./identity': identity,
		'./structure': structure
	});

	const modules = transpileAndLoad(path.join(schemaDir, 'modules.ts'), {
		'drizzle-orm': orm,
		'drizzle-orm/pg-core': pgCore,
		'./identity': identity
	});

	const authentication = transpileAndLoad(path.join(schemaDir, 'authentication.ts'), {
		'drizzle-orm': orm,
		'drizzle-orm/pg-core': pgCore,
		'./identity': identity
	});

	return {
		...identity,
		...structure,
		...auth,
		...modules,
		...authentication
	};
}

/**
 * Wraps a Drizzle QueryBuilder (PgInsertBuilder, PgSelect, etc.) so that
 * when awaited via `.then(...)`, lifecycle hooks are executed without breaking
 * fluent chaining methods (.values, .returning, .where, etc.).
 *
 * Recursively proxies all returned query builders in the chain, ensuring that
 * calls like `tx.insert(table).values(...).returning(...)` preserve the proxy
 * and execute onBeforeExecute exactly once upon query execution.
 *
 * @param {Object} builder - Drizzle query builder
 * @param {Object} hooks
 * @param {Function} [hooks.onBeforeExecute] - Async hook called right before the query runs
 * @param {Function} [hooks.onAfterExecute] - Async hook called right after query completes
 */
export function wrapQueryBuilder(builder, hooks = {}) {
	let executed = false;

	function createProxy(target) {
		return new Proxy(target, {
			get(obj, prop, receiver) {
				if (prop === 'then') {
					return (onFulfilled, onRejected) => {
						return (async () => {
							if (!executed && hooks.onBeforeExecute) {
								executed = true;
								await hooks.onBeforeExecute();
							}
							const result = await obj;
							if (hooks.onAfterExecute) {
								await hooks.onAfterExecute(result);
							}
							return result;
						})().then(onFulfilled, onRejected);
					};
				}

				const val = Reflect.get(obj, prop, receiver);

				if (typeof val === 'function') {
					return (...args) => {
						const res = val.apply(obj, args);
						if (res && (typeof res === 'object' || typeof res === 'function')) {
							return createProxy(res);
						}
						return res;
					};
				}

				return val;
			}
		});
	}

	return createProxy(builder);
}

/**
 * Local verification helper (runs completely without database connection).
 * Verifies that wrapQueryBuilder correctly preserves the proxy across the entire
 * fluent chaining sequence: `tx.insert(table).values(...).returning(...)`,
 * and that onBeforeExecute is called exactly once.
 *
 * @returns {Promise<{ ok: boolean, callCount: number }>}
 */
export async function testWrapQueryBuilderChainLocal() {
	const mockResult = [{ id: 'mock-uuid' }];
	const mockQuery = Promise.resolve(mockResult);
	mockQuery.values = () => Promise.resolve([['mock-uuid']]);

	const dummySql = () => mockQuery;
	dummySql.unsafe = () => mockQuery;
	dummySql.options = { parsers: {}, serializers: {} };

	const schema = loadLabSchema();
	const mockDb = drizzle(dummySql, { schema });

	let callCount = 0;
	const rawBuilder = mockDb.insert(schema.users);
	const proxied = wrapQueryBuilder(rawBuilder, {
		onBeforeExecute: async () => {
			callCount++;
		}
	});

	// Fluent chaining: insert -> values -> returning -> await
	const result = await proxied
		.values({ id: 'dummy-id', name: 'Test' })
		.returning({ id: schema.users.id });

	assert.equal(callCount, 1, 'onBeforeExecute must be called exactly once');
	assert.equal(result[0].id, 'mock-uuid', 'Result must contain returned row id');

	return { ok: true, callCount };
}

/**
 * Creates an instance of the real provisioning and authorization modules bound
 * to a verified live PostgreSQL connection client, with optional query interceptors
 * for deterministic concurrency synchronization.
 *
 * @param {import('postgres').Sql} sql - Verified postgres.js connection client
 * @param {Object} [options]
 * @param {Function} [options.wrapTransaction] - Optional proxy wrapper around tx for concurrency barriers
 */
export function createProvisioningClient(sql, options = {}) {
	const schema = loadLabSchema();
	const db = drizzle(sql, { schema });

	// Injected DB provider that uses the verified PostgreSQL database client
	const dbProvider = {
		getDb: () => ({
			transaction: async (operation) => {
				return db.transaction(async (realTx) => {
					// If a transaction wrapper was provided, apply it to tx
					const tx = options.wrapTransaction ? options.wrapTransaction(realTx) : realTx;
					return operation(tx);
				});
			}
		})
	};

	const authDir = path.join(getServerDir(), 'auth');

	const config = transpileAndLoad(path.join(authDir, 'config.ts'), {});

	const instance = transpileAndLoad(path.join(authDir, 'instance.ts'), {
		'$app/environment': { building: false, dev: false },
		'$env/dynamic/private': {
			env: {
				BETTER_AUTH_ENABLED: 'true',
				BETTER_AUTH_SECRET: SYNTHETIC_SECRET,
				BETTER_AUTH_URL: 'https://auth.example.test',
				DATABASE_URL: 'postgresql://soporteflow_lab_runner@localhost/soporteflow_concurrency_lab'
			}
		},
		'better-auth': { betterAuth },
		'better-auth/api': { APIError, createAuthMiddleware },
		'better-auth/adapters/drizzle': { drizzleAdapter },
		'../db': dbProvider,
		'../db/schema': schema,
		'./config': config
	});

	const principal = transpileAndLoad(path.join(authDir, 'principal.ts'), {
		'./instance': instance,
		'../db': dbProvider,
		'../db/schema': schema,
		'drizzle-orm': orm
	});

	const authorization = transpileAndLoad(path.join(authDir, 'authorization.ts'), {
		'./principal': principal,
		'../db': dbProvider,
		'../db/schema': schema,
		'drizzle-orm': orm
	});

	const provisioning = transpileAndLoad(path.join(authDir, 'provisioning.ts'), {
		'drizzle-orm': orm,
		'better-auth/crypto': {
			hashPassword,
			verifyPassword
		},
		'../db': dbProvider,
		'../db/schema': schema,
		'./authorization': authorization,
		'./principal': principal
	});

	return {
		schema,
		db,
		provisioning,
		authorization,
		principal,
		instance
	};
}
