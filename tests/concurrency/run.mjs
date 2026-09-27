#!/usr/bin/env node
/**
 * 5.4W-A runner: `npm run test:concurrency`. Refuses to start without a lab DATABASE_URL, then runs
 * every tests/concurrency/*.test.mjs file sequentially (files never share data or connections).
 * Extra arguments are forwarded to node --test (e.g. --test-name-pattern "last-admin").
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { labTarget } from './lab.mjs';
import { root } from './setup.mjs';

try {
	const target = labTarget();
	console.log(`[lab] 5.4W-A concurrency suite against ${target.redacted}`);
} catch (error) {
	console.error(error.message);
	process.exit(2);
}
const dir = path.join(root, 'tests/concurrency');
const files = fs
	.readdirSync(dir)
	.filter((f) => f.endsWith('.test.mjs'))
	.sort()
	.map((f) => path.join('tests/concurrency', f));
const result = spawnSync(
	process.execPath,
	[
		'--test',
		'--test-concurrency=1',
		'--test-timeout=300000',
		'--test-reporter=spec',
		...process.argv.slice(2),
		...files
	],
	{ cwd: root, stdio: 'inherit', env: process.env }
);
process.exit(result.status ?? 1);
