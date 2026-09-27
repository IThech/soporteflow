import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as api from '../src/lib/api/notification-preferences.ts';

const ORG = randomUUID();
const all = (over = {}) =>
	api.NOTIFICATION_EVENT_TYPES.map((eventType) => ({
		eventType,
		inAppEnabled: true,
		isDefault: true,
		...(over[eventType] ?? {})
	}));
function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}
function mock(respond) {
	const calls = [];
	const fetchFn = async (url, init) => {
		calls.push({ url, init });
		return typeof respond === 'function' ? respond(url, init) : respond;
	};
	return { fetchFn, calls };
}
async function rejectsWith(promise, { status, code }) {
	await assert.rejects(promise, (e) => {
		assert.ok(
			e instanceof api.NotificationPreferenceApiError,
			`esperado NotificationPreferenceApiError: ${e}`
		);
		if (status !== undefined) assert.equal(e.status, status);
		assert.equal(e.code, code);
		return true;
	});
}

test('SoporteFlow — Etapa 5.4U-B: cliente de preferencias de notificación', async (t) => {
	await t.test('list: GET same-origin, signal, parser estricto y extras descartados', async () => {
		const controller = new AbortController();
		const { fetchFn, calls } = mock(() =>
			json({
				preferences: all({
					'incident.assigned': { inAppEnabled: false, isDefault: false, userId: 'x' }
				}),
				extra: true
			})
		);
		const list = await api.listNotificationPreferences(ORG, {
			customFetch: fetchFn,
			signal: controller.signal
		});
		assert.equal(list.length, api.NOTIFICATION_EVENT_TYPES.length);
		assert.deepEqual(list[0], {
			eventType: 'incident.assigned',
			inAppEnabled: false,
			isDefault: false
		});
		assert.equal(calls[0].url, `/api/notification-preferences?organizationId=${ORG}`);
		assert.equal(calls[0].init.method, 'GET');
		assert.equal(calls[0].init.credentials, 'same-origin');
		assert.equal(calls[0].init.signal, controller.signal);
		assert.equal(calls[0].init.headers, undefined, 'sin cabeceras de identidad');
	});

	await t.test(
		'list: payload inválido, eventos desconocidos, duplicados o incompletos -> INVALID_PAYLOAD',
		async () => {
			for (const body of [
				{},
				{ preferences: 'x' },
				{ preferences: all().slice(1) },
				{ preferences: [...all().slice(1), all()[1]] },
				{
					preferences: all().map((p, i) => (i === 0 ? { ...p, eventType: 'incident.created' } : p))
				},
				{ preferences: all().map((p, i) => (i === 0 ? { ...p, inAppEnabled: 'true' } : p)) },
				{ preferences: all().map((p, i) => (i === 0 ? { ...p, isDefault: null } : p)) }
			])
				await rejectsWith(
					api.listNotificationPreferences(ORG, { customFetch: async () => json(body) }),
					{
						code: 'INVALID_PAYLOAD'
					}
				);
		}
	);

	await t.test(
		'set: PUT con cuerpo exacto, respuesta coherente; reset: DELETE sin cuerpo y 204',
		async () => {
			const { fetchFn, calls } = mock((url, init) =>
				init.method === 'PUT'
					? json({
							preference: {
								eventType: 'sla.resolution_breached',
								inAppEnabled: false,
								isDefault: false
							}
						})
					: new Response(null, { status: 204 })
			);
			const p = await api.setNotificationPreference(ORG, 'sla.resolution_breached', false, {
				customFetch: fetchFn
			});
			assert.deepEqual(p, {
				eventType: 'sla.resolution_breached',
				inAppEnabled: false,
				isDefault: false
			});
			assert.equal(
				calls[0].url,
				`/api/notification-preferences/sla.resolution_breached?organizationId=${ORG}`
			);
			assert.equal(calls[0].init.method, 'PUT');
			assert.deepEqual(JSON.parse(calls[0].init.body), { inAppEnabled: false });
			assert.equal(
				await api.resetNotificationPreference(ORG, 'sla.resolution_breached', {
					customFetch: fetchFn
				}),
				undefined
			);
			assert.equal(calls[1].init.method, 'DELETE');
			assert.equal(calls[1].init.body, undefined);
			for (const bad of [
				{ preference: { eventType: 'incident.assigned', inAppEnabled: false, isDefault: false } },
				{
					preference: { eventType: 'sla.resolution_breached', inAppEnabled: true, isDefault: false }
				},
				{
					preference: { eventType: 'sla.resolution_breached', inAppEnabled: false, isDefault: true }
				}
			])
				await rejectsWith(
					api.setNotificationPreference(ORG, 'sla.resolution_breached', false, {
						customFetch: async () => json(bad)
					}),
					{ code: 'INVALID_PAYLOAD' }
				);
			await rejectsWith(
				api.resetNotificationPreference(ORG, 'incident.assigned', {
					customFetch: async () => json({})
				}),
				{ code: 'INVALID_PAYLOAD' }
			);
		}
	);

	await t.test(
		'validación previa: org, evento desconocido y valor no booleano no llaman a fetch',
		async () => {
			const { fetchFn, calls } = mock(json({}));
			for (const promise of [
				api.listNotificationPreferences('x', { customFetch: fetchFn }),
				api.setNotificationPreference(ORG, 'incident.created', false, { customFetch: fetchFn }),
				api.setNotificationPreference(ORG, 'incident.assigned', 'false', { customFetch: fetchFn }),
				api.resetNotificationPreference(ORG, '../x', { customFetch: fetchFn }),
				api.resetNotificationPreference('', 'incident.assigned', { customFetch: fetchFn })
			])
				await rejectsWith(promise, { status: 0, code: 'INVALID_INPUT' });
			assert.equal(calls.length, 0);
		}
	);

	await t.test('errores HTTP con mensajes fijos; AbortError; NETWORK_ERROR', async () => {
		const res = (status) => async () => json({ error: { code: 'X', message: 'SQL leak' } }, status);
		for (const [status, code] of [
			[400, 'INVALID_INPUT'],
			[401, 'UNAUTHORIZED'],
			[403, 'FORBIDDEN'],
			[500, 'SERVER_ERROR']
		])
			await assert.rejects(
				api.listNotificationPreferences(ORG, { customFetch: res(status) }),
				(e) => {
					assert.equal(e.code, code);
					assert.ok(!e.message.includes('SQL'));
					return true;
				}
			);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			api.setNotificationPreference(ORG, 'incident.assigned', true, {
				signal: controller.signal,
				customFetch: async () => {
					throw new DOMException('aborted', 'AbortError');
				}
			}),
			(e) => e.name === 'AbortError'
		);
		await rejectsWith(
			api.resetNotificationPreference(ORG, 'incident.assigned', {
				customFetch: async () => {
					throw new TypeError('fetch failed');
				}
			}),
			{ status: 0, code: 'NETWORK_ERROR' }
		);
	});

	await t.test(
		'hardening: catálogo compartido, sin storage, demo ni cabeceras de identidad',
		() => {
			const source = fs.readFileSync('src/lib/api/notification-preferences.ts', 'utf8');
			assert.match(source, /from '\.\.\/notifications\/events\.ts'/);
			for (const forbidden of ['localStorage', 'sessionStorage', 'demo', 'x-user-id', 'userId'])
				assert.ok(!source.includes(forbidden), forbidden);
		}
	);
});
