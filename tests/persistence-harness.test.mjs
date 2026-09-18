import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations } from './helpers/persistence-migrations.mjs';

const migrations = [
	['0000_first', 'CREATE TABLE probe (id integer PRIMARY KEY);'],
	['0001_second', 'ALTER TABLE probe ADD COLUMN label text;'],
	['0002_third', "INSERT INTO probe (id, label) VALUES (1, 'complete');"]
];

function fixture(t, entries = migrations.map(([tag], idx) => ({ idx, tag }))) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soporteflow-persistence-'));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	fs.mkdirSync(path.join(directory, 'meta'));
	fs.writeFileSync(path.join(directory, 'meta/_journal.json'), JSON.stringify({ entries }));
	for (const [tag, sql] of migrations) fs.writeFileSync(path.join(directory, tag + '.sql'), sql);
	return directory;
}

test('Aplica todas las migraciones en orden, incluidos los separadores', async (t) => {
	const directory = fixture(t);
	fs.appendFileSync(
		path.join(directory, '0002_third.sql'),
		"\n--> statement-breakpoint\nINSERT INTO probe (id, label) VALUES (2, 'second statement');".replaceAll(
			'\\n',
			'\n'
		)
	);
	const database = new PGlite();
	t.after(() => database.close());
	const applied = await applyMigrations(database, directory);
	assert.deepEqual(
		applied,
		migrations.map(([tag]) => tag + '.sql')
	);
	assert.deepEqual((await database.query('SELECT * FROM probe ORDER BY id')).rows, [
		{ id: 1, label: 'complete' },
		{ id: 2, label: 'second statement' }
	]);
});

test('Valida el registro completo antes de ejecutar SQL', async (t) => {
	const cases = [
		[
			'archivo posterior ausente',
			/Missing migration/,
			(dir) => fs.unlinkSync(path.join(dir, '0002_third.sql'))
		],
		[
			'SQL sin registrar',
			/Unregistered migrations/,
			(dir) => fs.writeFileSync(path.join(dir, '0003_extra.sql'), 'SELECT 1;')
		],
		[
			'entrada duplicada',
			/duplicate entry/,
			(dir) =>
				fs.writeFileSync(
					path.join(dir, 'meta/_journal.json'),
					JSON.stringify({
						entries: [
							{ idx: 0, tag: '0000_first' },
							{ idx: 1, tag: '0000_first' }
						]
					})
				)
		],
		[
			'índices desordenados',
			/Invalid migration order/,
			(dir) =>
				fs.writeFileSync(
					path.join(dir, 'meta/_journal.json'),
					JSON.stringify({
						entries: [
							{ idx: 1, tag: '0001_second' },
							{ idx: 0, tag: '0000_first' }
						]
					})
				)
		],
		[
			'registro vacío',
			/Empty or invalid/,
			(dir) => fs.writeFileSync(path.join(dir, 'meta/_journal.json'), '{"entries":[]}')
		]
	];
	for (const [name, expected, modify] of cases) {
		await t.test(name, async (t) => {
			const directory = fixture(t);
			modify(directory);
			let calls = 0;
			await assert.rejects(
				applyMigrations(
					{
						exec: async () => {
							calls++;
						}
					},
					directory
				),
				expected
			);
			assert.equal(calls, 0);
		});
	}
});

test('Un fallo intermedio detiene las migraciones posteriores', async (t) => {
	const directory = fixture(t);
	fs.writeFileSync(path.join(directory, '0001_second.sql'), 'INVALID SQL;');
	// If execution continued after failure this independent statement would leave evidence.
	fs.writeFileSync(path.join(directory, '0002_third.sql'), 'INSERT INTO probe (id) VALUES (9);');
	const database = new PGlite();
	t.after(() => database.close());
	await assert.rejects(applyMigrations(database, directory), /Migration failed: 0001_second.sql/);
	assert.deepEqual((await database.query('SELECT * FROM probe')).rows, []);
});

function isolatedClient(privateEnv, processEnv) {
	const filename = new URL('../src/lib/server/db/index.ts', import.meta.url);
	const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true
		}
	}).outputText;
	let calls = 0;
	let selectedUrl;
	const blocked = new Error('Network driver blocked by persistence test');
	const module = { exports: {} };
	vm.runInNewContext(
		source,
		{
			exports: module.exports,
			module,
			process: { env: { ...processEnv } },
			require(id) {
				if (id === '$env/dynamic/private') return { env: { ...privateEnv } };
				if (id === 'postgres')
					return (url) => {
						calls++;
						selectedUrl = url;
						throw blocked;
					};
				if (id === 'drizzle-orm/postgres-js')
					return {
						drizzle() {
							throw blocked;
						}
					};
				if (id === './schema' || id === './types') return {};
				throw new Error('Unexpected dependency in isolated client test: ' + id);
			}
		},
		{ filename: 'isolated-db-client.cjs', timeout: 1000 }
	);
	return { api: module.exports, calls: () => calls, selectedUrl: () => selectedUrl, blocked };
}

test('Configuración aislada: ninguna prueba puede abrir una conexión PostgreSQL', async (t) => {
	const hadUrl = Object.hasOwn(process.env, 'DATABASE_URL');
	const originalUrl = process.env.DATABASE_URL;
	// The real environment is never changed; each client gets a separate VM environment.
	for (const [name, privateEnv, processEnv] of [
		['ausente', {}, {}],
		['vacía', { DATABASE_URL: '' }, { DATABASE_URL: '' }],
		['espacios', { DATABASE_URL: '   ' }, {}]
	]) {
		await t.test(name, () => {
			const { api, calls } = isolatedClient(privateEnv, processEnv);
			assert.throws(
				() => api.getDb(),
				(error) => error instanceof api.DatabaseConfigurationError
			);
			assert.equal(calls(), 0);
		});
	}
	for (const [name, privateEnv, processEnv, expected] of [
		['fuente privada', { DATABASE_URL: 'test-private' }, {}, 'test-private'],
		['alternativa process.env', {}, { DATABASE_URL: 'test-process' }, 'test-process'],
		[
			'prioridad de fuente privada',
			{ DATABASE_URL: 'test-private' },
			{ DATABASE_URL: 'test-process' },
			'test-private'
		]
	]) {
		await t.test(name, () => {
			const client = isolatedClient(privateEnv, processEnv);
			assert.throws(
				() => client.api.getDb(),
				(error) => error === client.blocked
			);
			assert.equal(client.calls(), 1);
			assert.equal(client.selectedUrl(), expected);
		});
	}
	assert.equal(Object.hasOwn(process.env, 'DATABASE_URL'), hadUrl);
	assert.ok(process.env.DATABASE_URL === originalUrl, 'Real environment must remain unchanged');
});
