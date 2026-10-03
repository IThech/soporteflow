import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Frontend review (Administración → Sedes spacing report): regression guards for
 * - design tokens: a var() without fallback to an undefined custom property silently drops the
 *   whole declaration (padding -> 0, gap -> 0, border-radius -> 0). That was the cause of the cramped
 *   Administración button and the unpadded Sedes cells;
 * - admin mutations: outcomes (data, errors, 401) of a write started under another
 *   user/organization/generation are ignored; no double submit while writing;
 * - admin tables: narrow screens scroll inside the card (actions never clipped) and inactive rows
 *   never dim their action buttons.
 */

const SRC = path.resolve('src');

function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else if (/\.(svelte|css)$/.test(entry.name)) out.push(full);
	}
	return out;
}

const read = (rel) => fs.readFileSync(path.resolve(rel), 'utf8');
const ADMIN_PAGES = ['sites', 'clients', 'categories'].map((name) => ({
	name,
	file: `src/routes/app/admin/${name}/+page.svelte`
}));

/** Body of `async function <name>` up to the next top-level function of the component script. */
function functionBody(source, name) {
	const start = source.indexOf(`async function ${name}(`);
	assert.notEqual(start, -1, `${name} existe`);
	const rest = source.slice(start + 1);
	const next = rest.search(/\n\t(async )?function |\n<\/script>/);
	return source.slice(start, start + 1 + next);
}

test('tokens: ningún var() sin fallback apunta a una propiedad que no existe', () => {
	const files = walk(SRC);
	const defined = new Set();
	for (const file of files)
		for (const match of fs.readFileSync(file, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/gi))
			defined.add(match[1]);
	const missing = [];
	for (const file of files) {
		const lines = fs.readFileSync(file, 'utf8').split('\n');
		lines.forEach((line, index) => {
			for (const match of line.matchAll(/var\((--[a-z0-9-]+)\s*\)/gi))
				if (!defined.has(match[1]))
					missing.push(`${path.relative(SRC, file)}:${index + 1} ${match[1]}`);
		});
	}
	assert.deepEqual(missing, [], 'cada token usado sin fallback debe estar definido');
});

test('tokens: medios pasos de espaciado y alias definidos en la escala, con valores coherentes', () => {
	const tokens = read('src/lib/styles/tokens.css');
	const value = (name) => tokens.match(new RegExp(`\\n\\s*${name}:\\s*([^;]+);`))?.[1].trim();
	assert.equal(value('--space-1-5'), '0.375rem');
	assert.equal(value('--space-2-5'), '0.625rem');
	assert.equal(value('--space-3-5'), '0.875rem');
	assert.equal(value('--radius-md'), 'var(--radius)');
	assert.equal(value('--text-emphasis'), 'var(--text-primary)');
	assert.equal(value('--surface-hover'), 'var(--surface-subtle)');
	// semantic text follows the AA, theme-aware semantic colors (no fixed hex)
	assert.equal(value('--warning-text'), 'var(--warning)');
	assert.equal(value('--danger-text'), 'var(--danger)');
	assert.equal(value('--success-text'), 'var(--success)');
	// steps beyond --space-8 would break the monotonic scale: not defined, not used
	for (const file of walk(SRC))
		assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /var\(--space-(12|16)\b/, file);
});

test('Topbar: el botón Administración separa icono/texto y tiene padding real', () => {
	const topbar = read('src/lib/components/shell/Topbar.svelte');
	const rule = topbar.match(/\.sf-topbar-admin-btn \{([^}]*)\}/)?.[1] ?? '';
	assert.match(rule, /gap: var\(--space-2\);/);
	assert.match(rule, /padding: 0 var\(--space-3-5\);/);
	assert.match(rule, /align-items: center;/);
	// an undefined token silently drops the declaration (padding -> 0, gap -> normal)
	const tokens = read('src/lib/styles/tokens.css');
	for (const token of ['--space-2', '--space-3-5', '--space-4', '--content-max-width'])
		assert.match(tokens, new RegExp(`${token}:`));
});

test('admin: toda mutación ignora resultados, errores y 401 de otro usuario/organización/generación', () => {
	const handlers = {
		sites: ['handleSaveSite', 'handleToggleActive'],
		clients: ['handleSaveClient', 'handleToggleActive'],
		categories: [
			'handleDialogSubmit',
			'handleToggleCategoryActive',
			'handleToggleSubcategoryActive'
		]
	};
	for (const { name, file } of ADMIN_PAGES) {
		const source = read(file);
		assert.match(
			source,
			/import \{ sameTenant, tenantIdentityOf \} from '\$lib\/app\/tenant-identity';/,
			`${name}: reutiliza la identidad de tenant existente`
		);
		assert.match(
			source,
			/function isCurrentTenant\([^)]*\): boolean \{\s*return started !== null && sameTenant\(started, tenantIdentityOf\(context\.get\(\)\)\);/,
			`${name}: compara usuario + organización + generación`
		);
		for (const handler of handlers[name]) {
			const body = functionBody(source, handler);
			const label = `${name}.${handler}`;
			assert.match(body, /const tenant = tenantIdentityOf\(context\.get\(\)\);/, label);
			// the identity is captured BEFORE the request is sent
			assert.ok(
				body.indexOf('const tenant = ') < body.search(/await [a-zA-Z]+\(/),
				`${label}: identidad capturada antes de la petición`
			);
			// after the write resolves, nothing is applied for a stale tenant
			const afterAwait = body.slice(body.search(/await [a-zA-Z]+\(/));
			assert.match(afterAwait, /if \(!isCurrentTenant\(tenant\)\)/, `${label}: éxito obsoleto`);
			// a stale failure (including a 401) never expires the session nor shows an error
			const catchBlock = body.slice(body.indexOf('} catch (err) {'));
			const staleCheck = catchBlock.search(/if \(!isCurrentTenant\(tenant\)\)/);
			assert.ok(staleCheck !== -1, `${label}: error obsoleto ignorado`);
			assert.ok(
				staleCheck < catchBlock.indexOf('expireSession()'),
				`${label}: el 401 obsoleto se descarta antes de expirar la sesión`
			);
		}
	}
});

test('admin: sin doble envío; Escape/fondo no abandonan una escritura en curso', () => {
	const submit = {
		sites: 'handleSaveSite',
		clients: 'handleSaveClient',
		categories: 'handleDialogSubmit'
	};
	for (const { name, file } of ADMIN_PAGES) {
		const source = read(file);
		assert.match(
			functionBody(source, submit[name]),
			/if \(!activeOrg \|\| formSubmitting\) return;/,
			`${name}: el envío no reentra`
		);
		const close = source.slice(source.indexOf('function closeDialog() {'));
		assert.match(
			close.slice(0, close.indexOf('\n\t}')),
			/^function closeDialog\(\) \{\s*(\/\/[^\n]*\s*)?if \(formSubmitting\) return;/,
			`${name}: closeDialog no cierra durante la escritura`
		);
		// Escape and backdrop go through the guarded closeDialog
		assert.match(source, /e\.key === 'Escape' && dialogMode !== 'closed'\) closeDialog\(\)/);
	}
});

test('admin: tablas con scroll interno (acciones nunca recortadas) y filas inactivas sin atenuar acciones', () => {
	for (const { name, file } of ADMIN_PAGES.filter((page) => page.name !== 'categories')) {
		const source = read(file);
		const wrapper = source.match(/\.sf-table-wrapper \{([^}]*)\}/)?.[1] ?? '';
		assert.match(wrapper, /overflow-x: auto;/, `${name}: scroll dentro de la tarjeta`);
		assert.doesNotMatch(wrapper, /overflow: hidden;/, `${name}: nada se recorta`);
		const inactive = source.match(/\t\.sf-row-inactive \{([^}]*)\}/)?.[1] ?? '';
		assert.doesNotMatch(inactive, /opacity/, `${name}: la fila completa no se atenúa`);
		assert.match(source, /\.sf-row-inactive td:not\(\.sf-cell-actions\) \{\s*opacity: 0\.75;/);
		// actions pinned from tablet width, plain scroll on phones
		assert.match(
			source,
			/@media \(min-width: 640px\) \{[\s\S]*?td\.sf-cell-actions \{\s*position: sticky;\s*right: 0;/,
			`${name}: acciones fijas a partir de tablet`
		);
		// headers and cells share the horizontal padding: columns stay aligned
		const th = source.match(/-table th \{([^}]*)\}/)?.[1] ?? '';
		const td = source.match(/-table td \{([^}]*)\}/)?.[1] ?? '';
		const horizontal = (rule) => rule.match(/padding: \S+ (var\(--space-\d\))/)?.[1];
		assert.equal(horizontal(th), horizontal(td), `${name}: th y td alineados`);
		assert.equal(horizontal(td), 'var(--space-5)', `${name}: mismo padding que el resto`);
	}
});

test('limpieza: DemoSessionSelector retirado sin consumidores', () => {
	assert.equal(fs.existsSync(path.resolve('src/lib/components/DemoSessionSelector.svelte')), false);
	for (const file of walk(SRC))
		assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /DemoSessionSelector/, file);
});

test('fecha corta de catálogo: un único formateador, igual que antes y sin "Invalid Date"', async () => {
	const { formatShortDate } = await import('../src/lib/app/date-presentation.ts');
	const iso = '2026-10-02T10:00:00.000Z';
	// same output the three pages produced with their local copies
	const before = new Date(iso).toLocaleDateString('es-ES', {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
	assert.equal(formatShortDate(iso), before);
	assert.equal(formatShortDate('no-es-fecha'), '—');
	for (const { name, file } of ADMIN_PAGES) {
		const source = read(file);
		assert.doesNotMatch(source, /function formatDate\(/, `${name}: sin copia local`);
		assert.match(source, /import \{ formatShortDate \} from '\$lib\/app\/date-presentation';/);
	}
});

test('sesión expirada: un único destino definido, ninguna página lo reescribe', async () => {
	const signOut = await import('../src/lib/app/sign-out.ts');
	const navigation = await import('../src/lib/app/incident-create-navigation.ts');
	assert.equal(signOut.SESSION_EXPIRED_PATH, '/login?expired=true');
	assert.equal(navigation.SESSION_EXPIRED_PATH, signOut.SESSION_EXPIRED_PATH, 'contrato UI-2B');
	const literal = /['"]\/login\?expired=true['"]/;
	for (const file of walk(path.resolve('src/routes/app')).concat(walk(path.resolve('src/lib'))))
		if (!file.includes(`${path.sep}demo${path.sep}`) && !file.endsWith(`sign-out.ts`))
			assert.doesNotMatch(fs.readFileSync(file, 'utf8'), literal, file);
});

test('modales: todos los diálogos reales retienen el foco de teclado', () => {
	const dialogs = [
		...ADMIN_PAGES.map((page) => page.file),
		'src/lib/components/incidents/IncidentAssignModal.svelte',
		'src/lib/components/incidents/IncidentConfirmModal.svelte',
		'src/lib/components/incidents/IncidentClassificationModal.svelte'
	];
	for (const file of dialogs) {
		const source = read(file);
		assert.match(source, /import \{ focusTrap \} from '\$lib\/ui\/focus-trap';/, file);
		assert.match(
			source,
			/role="(alert)?dialog"[^>]*aria-modal="true"[^>]*use:focusTrap/,
			`${file}: el diálogo modal usa focusTrap`
		);
	}
	const trap = read('src/lib/ui/focus-trap.ts');
	assert.match(trap, /removeEventListener\('keydown', onKeydown\)/, 'el listener se limpia');
});

test('CSS: sin !important fuera del reset de movimiento reducido; breakpoints 639/640', () => {
	for (const file of walk(SRC)) {
		if (/[\\/](demo|landing)[\\/]|theme\.css|public-home\.css/.test(file)) continue;
		const source = fs.readFileSync(file, 'utf8');
		const important = source.match(/!important/g)?.length ?? 0;
		if (file.endsWith('tokens.css')) assert.equal(important, 3, 'solo prefers-reduced-motion');
		else assert.equal(important, 0, file);
		assert.doesNotMatch(source, /@media \((min-width: 641px|max-width: 640px)\)/, file);
	}
});

test('admin hub: cuadrícula uniforme (filas iguales y pies de tarjeta del mismo alto)', () => {
	const source = read('src/routes/app/admin/+page.svelte');
	const grid = source.match(/\.sf-modules-grid \{([^}]*)\}/)?.[1] ?? '';
	assert.match(
		grid,
		/grid-auto-rows: 1fr;/,
		'todas las filas con la altura de la tarjeta más alta'
	);
	const label = source.match(/\.sf-card-inactive-label \{([^}]*)\}/)?.[1] ?? '';
	assert.match(label, /min-height: 2rem;/, 'mismo alto que el Button sm de las tarjetas activas');
	// the cards reflect the implemented modules only
	for (const active of ['clientsHref', 'sitesHref', 'categoriesHref'])
		assert.match(source, new RegExp(`href: ${active}`));
});

test('topbar: comparte el contenedor del contenido (sus bordes quedan alineados)', () => {
	const tokens = read('src/lib/styles/tokens.css');
	assert.match(tokens, /--content-max-width: 80rem;/);
	const shell = read('src/lib/components/shell/AppShell.svelte');
	assert.match(shell, /\.sf-content \{\s*max-width: var\(--content-max-width\);/);
	const topbar = read('src/lib/components/shell/Topbar.svelte');
	assert.match(topbar, /<header class="sf-topbar">\s*<div class="sf-topbar-inner">/);
	assert.match(
		topbar,
		/\.sf-topbar-inner \{[^}]*max-width: var\(--content-max-width\);[^}]*margin: 0 auto;/
	);
	assert.doesNotMatch(topbar, /margin-right: \d+px/, 'sin márgenes arbitrarios');
});

test('admin: el foco vuelve al disparador tras guardar, cancelar o Escape', () => {
	for (const [name, entity] of [
		['sites', 'site'],
		['clients', 'client']
	]) {
		const source = read(`src/routes/app/admin/${name}/+page.svelte`);
		assert.match(source, new RegExp(`onclick=\\{\\(e\\) => openEditDialog\\(${entity}, e\\)\\}`));
		const save = functionBody(source, name === 'sites' ? 'handleSaveSite' : 'handleSaveClient');
		const success = save.slice(0, save.indexOf('} catch (err) {'));
		assert.doesNotMatch(success, /dialogMode = 'closed'/, `${name}: éxito sin cerrar a mano`);
		assert.equal(success.match(/closeDialog\(\);/g)?.length, 2, `${name}: crear y editar`);
	}
	// categories: Input's bound element IS the <input> (no querySelector on it)
	const categories = read('src/routes/app/admin/categories/+page.svelte');
	assert.match(categories, /setTimeout\(\(\) => nameInputElement\?\.focus\(\), 50\)/);
	assert.doesNotMatch(categories, /nameInputElement\.querySelector/);
});

test('admin: filtros con estado accesible y acciones con nombre propio', () => {
	for (const { name, file } of ADMIN_PAGES) {
		const source = read(file);
		for (const value of ['all', 'active', 'inactive'])
			assert.match(
				source,
				new RegExp(`aria-pressed=\\{statusFilter === '${value}'\\}`),
				`${name}: ${value}`
			);
		assert.match(source, /role="group"\s+aria-label="Filtro por estado"/, name);
		assert.doesNotMatch(source, /role="tablist"/, `${name}: sin tablist sin tabs`);
	}
	const categories = read('src/routes/app/admin/categories/+page.svelte');
	assert.match(categories, /`Añadir subcategoría a \$\{category\.name\}`/);
	assert.match(categories, /`Añadir la primera subcategoría a \$\{category\.name\}`/);
	assert.match(
		categories,
		/subcategorías de \$\{category\.name\}`\}\s*aria-expanded=\{!isCollapsed\}/
	);
	assert.match(categories, /<title>Categorías · SoporteFlow<\/title>/);
});

test('CSS: el anillo de foco se usa tal cual (es una lista de sombras completa)', () => {
	for (const file of walk(SRC))
		assert.doesNotMatch(
			fs.readFileSync(file, 'utf8'),
			/\d+px var\(--focus-ring\)/,
			`${file}: "0 0 0 2px var(--focus-ring)" es inválido y elimina el foco visible`
		);
});

test('responsive: acciones de categorías y pestañas de actividad se ajustan en móvil', () => {
	const categories = read('src/routes/app/admin/categories/+page.svelte');
	for (const rule of [
		'sf-category-header',
		'sf-category-actions',
		'sf-subcategory-row',
		'sf-subcategory-actions'
	])
		assert.match(
			categories.match(new RegExp(`\\.${rule} \\{([^}]*)\\}`))?.[1] ?? '',
			/flex-wrap: wrap;/,
			rule
		);
	const activity = read('src/lib/components/incidents/IncidentActivity.svelte');
	assert.match(activity.match(/\.sf-activity-tabs \{([^}]*)\}/)?.[1] ?? '', /flex-wrap: wrap;/);
});
