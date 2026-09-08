import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createServer } from 'vite';

test('Preferencia de apariencia y arranque antes de hidratar', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });
	try {
		const { parseTheme, resolveTheme, readTheme, saveTheme, THEME_KEY } =
			await server.ssrLoadModule('/src/lib/theme.ts');
		for (const value of ['light', 'dark', 'system'])
			await t.test(`Valor valido: ${value}`, () => assert.equal(parseTheme(value), value));
		await t.test('Valores invalidos y ausentes usan system', () => {
			for (const value of [null, undefined, '', 'DARK', 'invalid', {}, 1])
				assert.equal(parseTheme(value), 'system');
		});
		for (const preference of ['light', 'dark', 'system'])
			await t.test(`Cambios del sistema con ${preference}`, () => {
				for (const dark of [false, true, false])
					assert.equal(
						resolveTheme(preference, dark),
						preference === 'system' ? (dark ? 'dark' : 'light') : preference
					);
			});
		await t.test('Persistencia independiente y fallos de almacenamiento', () => {
			const values = new Map();
			const storage = {
				getItem: (key) => values.get(key) ?? null,
				setItem: (key, value) => values.set(key, value)
			};
			assert.equal(THEME_KEY, 'soporteflow-theme');
			assert.equal(readTheme(storage), 'system');
			for (const value of ['light', 'dark', 'system']) {
				assert.equal(saveTheme(storage, value), true);
				assert.equal(values.get('soporteflow-theme'), value);
				assert.equal(readTheme(storage), value);
			}
			assert.equal(values.size, 1);
			assert.equal(
				readTheme({
					getItem() {
						throw Error('Denied');
					}
				}),
				'system'
			);
			assert.equal(
				saveTheme(
					{
						setItem() {
							throw Error('Denied');
						}
					},
					'dark'
				),
				false
			);
		});
		const template = await readFile(new URL('../src/app.html', import.meta.url), 'utf8');
		const bootstrap = template.match(/<script>([\s\S]*?)<\/script>/)[1];
		await t.test('Arranque temprano coincide con resolver y no afecta landing', () => {
			for (const pathname of ['/', '/application', '/app', '/app/'])
				for (const stored of [null, 'invalid', 'light', 'dark', 'system'])
					for (const dark of [true, false]) {
						const document = { documentElement: { dataset: {} } };
						runInNewContext(bootstrap, {
							location: { pathname },
							localStorage: {
								getItem: (key) => {
									assert.equal(key, THEME_KEY);
									return stored;
								}
							},
							matchMedia: () => ({ matches: dark }),
							document
						});
						assert.equal(
							document.documentElement.dataset.appTheme,
							pathname === '/app' || pathname === '/app/'
								? resolveTheme(parseTheme(stored), dark)
								: undefined
						);
					}
		});
		await t.test('Arranque con localStorage bloqueado', () => {
			const document = { documentElement: { dataset: {} } };
			runInNewContext(bootstrap, {
				location: { pathname: '/app' },
				localStorage: {
					getItem() {
						throw Error('Denied');
					}
				},
				matchMedia: () => ({ matches: true }),
				document
			});
			assert.equal(document.documentElement.dataset.appTheme, 'dark');
		});
	} finally {
		await server.close();
	}
});
