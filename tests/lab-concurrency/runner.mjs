#!/usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	createVerifiedLabConnection,
	verifyRequiredCatalogPermissions,
	AUTHORIZED_LAB_SOCKET,
	AUTHORIZED_LAB_DATABASE,
	AUTHORIZED_LAB_USER
} from './safeguards.mjs';
import { testWrapQueryBuilderChainLocal } from './module-loader.mjs';
import {
	runScenarioA,
	runScenarioB1,
	runScenarioB2,
	runScenarioC1,
	runScenarioC2,
	runScenarioD1,
	runScenarioD2,
	runScenarioE,
	runScenarioF
} from './scenarios.mjs';

/**
 * Master Concurrency Lab Runner.
 * Orchestrates pre-flight invariant verification and sequential scenario execution.
 */
export async function runLabSuite() {
	console.log('='.repeat(80));
	console.log('SOPORTEFLOW — EJECUTOR DE CONCURRENCIA (FASE D)');
	console.log(`Socket local autorizado: ${AUTHORIZED_LAB_SOCKET}`);
	console.log(`Base de datos autorizada: ${AUTHORIZED_LAB_DATABASE}`);
	console.log(`Usuario autorizado: ${AUTHORIZED_LAB_USER}`);
	console.log('='.repeat(80));

	let preflightConn = null;

	try {
		console.log('\n[PRE-FLIGHT] Verificando protecciones y entorno de laboratorio...');
		preflightConn = await createVerifiedLabConnection();
		console.log(`✓ Base de datos confirmada: ${AUTHORIZED_LAB_DATABASE}`);
		console.log(`✓ Usuario verificado: ${AUTHORIZED_LAB_USER} (sin privilegios de superusuario)`);
		console.log(`✓ Conexión UNIX local verificada (inet_server_addr IS NULL)`);
		console.log(`✓ 21 tablas relacionales del Core v1 confirmadas en el esquema público.`);

		await verifyRequiredCatalogPermissions(preflightConn);
		console.log(
			`✓ Catálogo de permisos globales verificado (solo lectura: identities:create, memberships:create, roles:assign).`
		);

		console.log(`✓ Timeouts de seguridad establecidos por sesión (lock=4s, stmt=6s).\n`);
	} catch (error) {
		console.error(`\n[ABORT] Falló la verificación previa de seguridad: ${error.message}`);
		console.error('El ejecutor se ha detenido sin realizar ninguna operación sobre los datos.');
		if (preflightConn) {
			await preflightConn.end({ timeout: 1 }).catch(() => {});
		}
		process.exitCode = 1;
		return;
	} finally {
		if (preflightConn) {
			await preflightConn.end({ timeout: 1 }).catch(() => {});
		}
	}

	const scenarios = [
		{
			id: 'A',
			name: 'Colisión de correos duplicados (LOWER)',
			fn: runScenarioA
		},
		{
			id: 'B.1',
			name: 'Revocación de sesión previa',
			fn: runScenarioB1
		},
		{
			id: 'B.2',
			name: 'Revocación de sesión concurrente (FOR SHARE)',
			fn: runScenarioB2
		},
		{
			id: 'C.1',
			name: 'Desactivación de usuario concurrente (FOR SHARE)',
			fn: runScenarioC1
		},
		{
			id: 'C.2',
			name: 'Desactivación de usuario previa',
			fn: runScenarioC2
		},
		{
			id: 'D.1',
			name: 'Desactivación de rol concurrente (FOR UPDATE)',
			fn: runScenarioD1
		},
		{
			id: 'D.2',
			name: 'Revocación de permiso previa',
			fn: runScenarioD2
		},
		{
			id: 'E',
			name: 'Fallo forzado y Rollback atómico completo',
			fn: runScenarioE
		},
		{
			id: 'F',
			name: 'Prevención de interbloqueos (ordenación de roles)',
			fn: runScenarioF
		}
	];

	const results = [];
	let hasFailures = false;

	console.log('Ejecutando escenarios de concurrencia con conexiones PostgreSQL independientes:\n');

	for (const s of scenarios) {
		const start = Date.now();
		process.stdout.write(`  [${s.id}] ${s.name}... `);
		try {
			const res = await s.fn();
			const elapsed = Date.now() - start;
			console.log(`✓ SUPERADO (${elapsed}ms)`);
			results.push({ ...res, elapsed });
		} catch (error) {
			hasFailures = true;
			const elapsed = Date.now() - start;
			console.log(`✗ FALLIDO (${elapsed}ms)`);
			console.error(`      Detalle del fallo: ${error.message}`);
			results.push({
				scenario: s.name,
				status: 'FAILED',
				details: error.message,
				elapsed
			});
		}
	}

	console.log('\n' + '='.repeat(80));
	console.log('RESUMEN DE RESULTADOS DE CONCURRENCIA');
	console.log('='.repeat(80));
	for (const r of results) {
		console.log(
			`- ${r.scenario}: ${r.status === 'PASSED' ? '✓ OK' : '✗ ERROR'} (${r.elapsed}ms) -> ${r.details}`
		);
	}
	console.log('='.repeat(80));

	if (hasFailures) {
		console.error('\nSe detectaron fallos en la suite de concurrencia.');
		process.exitCode = 1;
	} else {
		console.log('\nTodos los escenarios de concurrencia se superaron con éxito.');
		process.exitCode = 0;
	}
}

// Execute CLI when run directly
const isDirectExecution =
	process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectExecution) {
	if (process.argv.includes('--test-chain')) {
		testWrapQueryBuilderChainLocal()
			.then((res) => {
				console.log(
					`[OK] wrapQueryBuilder chaining verificado localmente: onBeforeExecute invocada ${res.callCount} vez.`
				);
				process.exitCode = 0;
			})
			.catch((err) => {
				console.error(`[FAIL] Falló verificación de cadena: ${err.message}`);
				process.exitCode = 1;
			});
	} else {
		runLabSuite().catch((err) => {
			console.error(`\n[FATAL ERROR] ${err.message}`);
			process.exitCode = 1;
		});
	}
}
