import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 5.4W-A regression guard (static). On real PostgreSQL, drizzle's postgres-js driver installs
 * pass-through serializers for timestamp types, so a JS Date interpolated in a raw sql`…` template
 * reaches postgres-js unconverted and the query fails (ERR_INVALID_ARG_TYPE). PGlite accepts it,
 * so the unit suite cannot catch it at runtime: this guard rejects the pattern in server code.
 * Compare timestamps with typed operators (lt/lte/gt/gte/eq) or pass an ISO string with an
 * explicit ::timestamptz cast. The runtime proof lives in tests/concurrency (real PostgreSQL).
 */
const TIME_NAMES =
	/^(now|before|after|cutoff|until|deadline|since|at|date|dueAt|expiresAt|leaseUntil|startedAt|completedAt|createdAt|updatedAt)$/i;

function walk(dir) {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.flatMap((e) =>
			e.isDirectory()
				? walk(path.join(dir, e.name))
				: e.name.endsWith('.ts')
					? [path.join(dir, e.name)]
					: []
		);
}

test('5.4W-A: ningún Date de JS interpolado en plantillas sql`` crudas', () => {
	const offenders = [];
	const template = /sql(<[^>]*>)?`((?:[^`\\]|\\.)*)`/g;
	for (const file of [...walk('src/lib/server'), ...walk('src/routes')]) {
		const source = fs.readFileSync(file, 'utf8');
		for (const match of source.matchAll(template)) {
			for (const [, expression] of match[2].matchAll(/\$\{([^}]*)\}/g)) {
				const name = expression.trim().split('.').at(-1);
				const isBareOrProp = /^[A-Za-z_][\w.]*$/.test(expression.trim());
				// table columns (incidents.createdAt, e.completedAt…) are column references, not values
				const looksLikeColumn = expression.trim().includes('.');
				// a variable explicitly typed as a column or SQL fragment is not a JS value
				if (!isBareOrProp || looksLikeColumn || !TIME_NAMES.test(name)) continue;
				const typedAsColumn = new RegExp(`\\b${name}\\s*:\\s*(AnyPgColumn|PgColumn|SQL)\\b`).test(
					source
				);
				if (!typedAsColumn) {
					const line = source.slice(0, match.index).split('\n').length;
					offenders.push(`${file}:${line} \${${expression.trim()}}`);
				}
			}
		}
	}
	assert.deepEqual(offenders, [], 'use lt/lte/gt/gte or `${iso}::timestamptz`');
});

test('5.4W-A: la guarda detecta el patrón que falló en PostgreSQL real', () => {
	const sample = "sql`${executions.status} = 'processing' AND ${executions.leaseUntil} <= ${now}`";
	const expressions = [...sample.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
	assert.ok(expressions.some((e) => !e.includes('.') && TIME_NAMES.test(e)));
});
