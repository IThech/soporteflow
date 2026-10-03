import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('SoporteFlow — Categorías: Panel de administración y UI', async (t) => {
	await t.test('1. Tarjeta Categorías en /app/admin/+page.svelte', async () => {
		const adminPagePath = path.resolve('src/routes/app/admin/+page.svelte');
		assert.ok(fs.existsSync(adminPagePath), '/app/admin/+page.svelte debe existir');
		const content = fs.readFileSync(adminPagePath, 'utf8');

		// Check categoriesHref
		assert.match(
			content,
			/const categoriesHref = \$derived\(/,
			'categoriesHref debe estar definido como store derivado'
		);
		assert.match(
			content,
			/\/app\/admin\/categories/,
			'categoriesHref debe apuntar a /app/admin/categories'
		);

		// Check card in modules list
		assert.match(
			content,
			/title:\s*'Categorías'[\s\S]*?active:\s*true/,
			'La tarjeta de Categorías debe estar active: true'
		);
		assert.match(
			content,
			/title:\s*'Categorías'[\s\S]*?href:\s*categoriesHref/,
			'La tarjeta de Categorías debe enlazar a categoriesHref'
		);
		assert.match(
			content,
			/title:\s*'Categorías'[\s\S]*?actionLabel:\s*'Gestionar categorías'/,
			'La tarjeta de Categorías debe tener actionLabel "Gestionar categorías"'
		);

		// Access comes from the shared admin rule (capabilities.ts), not a local list
		assert.match(
			content,
			/title:\s*'Categorías'[\s\S]*?module:\s*'categories'/,
			'La tarjeta de Categorías se abre según el guard real del módulo'
		);
		const { ADMIN_MODULE_ACCESS } = await import('../src/lib/app/capabilities.ts');
		assert.deepEqual([...ADMIN_MODULE_ACCESS.categories].sort(), [
			'categories:manage',
			'categories:view'
		]);
	});

	await t.test('2. UI de Categorías: tokens de diseño, data-sf-ui y accesibilidad', () => {
		const filePath = path.resolve('src/routes/app/admin/categories/+page.svelte');
		assert.ok(fs.existsSync(filePath), 'El archivo /app/admin/categories/+page.svelte existe');
		const content = fs.readFileSync(filePath, 'utf8');

		// Inside AppShell
		const appShellCloseIndex = content.lastIndexOf('</AppShell>');
		const modalIndex = content.indexOf('class="sf-modal-backdrop"');
		assert.ok(modalIndex !== -1, 'sf-modal-backdrop presente en el código');
		assert.ok(
			modalIndex < appShellCloseIndex,
			'El modal debe renderizarse DENTRO de AppShell para heredar el contexto data-sf-ui'
		);

		// data-sf-ui explicitly on the backdrop
		assert.match(
			content,
			/class="sf-modal-backdrop"[^>]*data-sf-ui|data-sf-ui[^>]*class="sf-modal-backdrop"/,
			'Backdrop del modal incluye data-sf-ui'
		);

		// CSS rules must use theme design tokens
		assert.match(
			content,
			/\.sf-modal-dialog\s*\{[^}]*background:\s*var\(--surface-card/,
			'El diálogo usa var(--surface-card)'
		);
		assert.match(
			content,
			/\.sf-modal-backdrop\s*\{[^}]*background:\s*var\(--overlay/,
			'El overlay usa var(--overlay)'
		);

		// Accessible keyboard handling (Escape) and focus
		assert.match(
			content,
			/onkeydown=[\s\S]*?Escape[\s\S]*?closeDialog/,
			'Cierre accesible con tecla Escape'
		);
		assert.match(content, /bind:element=\{nameInputElement\}/, 'Enlace de elemento para auto-foco');
	});
});
