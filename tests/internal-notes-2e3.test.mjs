import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';

test('2E.3: notas internas, permisos, historial y recuperación simple', async (t) => {
	const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
	try {
		const mod = (p) => server.ssrLoadModule(`/src/lib/${p}`);
		const { createMessage, canUseMessages, canCreateMessage, visibleMessages } =
			await mod('incidents/messages.ts');
		const { hasPermission, rolePermissions } = await mod('auth/permissions.ts');
		const { loadMessages, appendMessage, MESSAGES_KEY } = await mod('storage/messages.ts');
		const { completeInternalNoteEffects } = await mod('storage/internal-note-effects.ts');
		const { HISTORY_KEY, RECOVERY_KEY, INCIDENTS_KEY } = await mod('storage/assignment.ts');
		const { NOTIFICATIONS_KEY } = await mod('storage/notifications.ts');
		const { isIncidentHistory } = await mod('incidents/history.ts');
		const { visibleIncidentHistory, describeHistoryEvent } = await mod('incidents/timeline.ts');
		const { filterUserNotifications, countUnreadNotifications, buildIncidentNotification } =
			await mod('incidents/notifications.ts');
		const { sendIncidentMessage } = await mod('storage/first-response.ts');
		const { getClientPendingResponseTimestamp } = await mod('incidents/technician-dashboard.ts');
		const { demoUsers: users } = await mod('data/users.ts');
		const tech = users.find((u) => u.role === 'technician');
		const other = users.find((u) => u.role === 'technician' && u.id !== tech.id);
		const admin = users.find((u) => u.role === 'organization_admin');
		const client = users.find((u) => u.role === 'client');
		const platform = users.find((u) => u.role === 'platform_admin');
		const incident = {
			id: 42,
			organizationId: tech.organizationId,
			clientUserId: client.id,
			assignedToUserId: other.id,
			title: 'Caso',
			client: 'Cliente',
			status: 'open',
			priority: 'low',
			createdAt: '2026-09-17'
		};
		const note = (actor = tech, ticket = incident, content = '  Secreto\nsegunda línea  ') =>
			createMessage(actor, ticket, 'internal', content, []);
		const store = () => {
			const values = new Map();
			let failKey = null;
			return {
				values,
				getItem: (k) => values.get(k) ?? null,
				setItem(k, v) {
					if (k === failKey) throw Error('Quota');
					values.set(k, v);
				},
				removeItem: (k) => values.delete(k),
				fail(k) {
					failKey = k;
				}
			};
		};
		const saved = (ticket = incident) => {
			const s = store();
			const n = note(tech, ticket);
			appendMessage(s, tech, ticket, n, null);
			return [s, n];
		};
		const complete = (s, n, ticket = incident, list = users) =>
			completeInternalNoteEffects(s, tech, ticket, n, list);

		await t.test('Matriz explícita, usuarios inactivos y técnicos no asignados', () => {
			for (const actor of [tech, other, admin, platform]) {
				assert.equal(hasPermission(actor, 'incidents:view_internal_notes'), true);
				assert.equal(hasPermission(actor, 'incidents:add_internal_note'), true);
				assert.equal(note(actor).authorUserId, actor.id);
				assert.equal(canUseMessages({ ...actor, active: false }, incident, 'internal'), false);
				assert.throws(() => note({ ...actor, active: false }));
			}
			assert.equal(hasPermission(client, 'incidents:add_internal_note'), false);
			assert.throws(() => note(client));
			assert.throws(() => note({ ...tech, organizationId: 'foreign' }));
			assert.equal(
				note(platform, { ...incident, organizationId: 'foreign' }).organizationId,
				'foreign'
			);
		});
		await t.test('Permisos de lectura y creación separados, no roles incrustados', () => {
			const previous = rolePermissions.technician;
			try {
				rolePermissions.technician = previous.filter((p) => p !== 'incidents:add_internal_note');
				assert.equal(canUseMessages(tech, incident, 'internal'), true);
				assert.equal(canCreateMessage(tech, incident, 'internal'), false);
				assert.throws(() => note());
			} finally {
				rolePermissions.technician = previous;
			}
		});
		await t.test('Estados: abiertas, pendientes y resueltas; cerradas solo lectura', () => {
			for (const status of ['open', 'pending', 'resolved'])
				assert.equal(note(tech, { ...incident, status }).visibility, 'internal');
			const n = note();
			const closed = { ...incident, status: 'closed' };
			assert.deepEqual(visibleMessages(tech, closed, [n]), [n]);
			assert.throws(() => note(tech, closed));
			assert.throws(() => appendMessage(store(), tech, closed, n, null));
		});
		await t.test('Límite en creación y persistencia, trim, texto plano y legado largo', () => {
			assert.equal(note(tech, incident, ' a\nb ').content, 'a\nb');
			assert.equal(note(tech, incident, 'x'.repeat(4000)).content.length, 4000);
			assert.throws(() => note(tech, incident, 'x'.repeat(4001)));
			assert.throws(() => note(tech, incident, ' \n '));
			const old = { ...note(), content: 'x'.repeat(6000) };
			const s = store();
			const raw = JSON.stringify([old]);
			s.setItem(MESSAGES_KEY, raw);
			assert.deepEqual(loadMessages(raw), [old]);
			assert.throws(() => appendMessage(store(), tech, incident, old, null));
			appendMessage(s, tech, incident, note(), raw);
			assert.equal(loadMessages(s.getItem(MESSAGES_KEY))[0].content.length, 6000);
			assert.equal(
				createMessage(tech, incident, 'public', 'x'.repeat(5000), []).content.length,
				5000
			);
		});
		await t.test('Evento mínimo válido, sin contenido y reintento idempotente', () => {
			const [s, n] = saved();
			const { history, notifications } = complete(s, n);
			assert.equal(isIncidentHistory(history), true);
			assert.equal(history[0].eventType, 'internal_note_added');
			assert.deepEqual(history[0].newValue, { messageId: n.id });
			assert.ok(!JSON.stringify(history).includes(n.content));
			assert.ok(describeHistoryEvent(history[0], users).includes('añadió una nota interna'));
			assert.equal(notifications[0].recipientUserId, other.id);
			complete(s, n);
			assert.equal(JSON.parse(s.getItem(HISTORY_KEY)).length, 1);
			assert.equal(JSON.parse(s.getItem(NOTIFICATIONS_KEY)).length, 1);
			assert.equal(loadMessages(s.getItem(MESSAGES_KEY)).length, 1);
		});
		await t.test('Clientes no ven evento, autor, conteo, contenido ni notificación', () => {
			const [s, n] = saved();
			const { history, notifications } = complete(s, n);
			assert.deepEqual(visibleMessages(client, incident, [n]), []);
			assert.deepEqual(visibleIncidentHistory(client, incident, history), []);
			assert.deepEqual(
				filterUserNotifications(
					client,
					notifications.map((x) => ({ ...x, recipientUserId: client.id }))
				),
				[]
			);
			assert.equal(
				countUnreadNotifications(
					client,
					notifications.map((x) => ({ ...x, recipientUserId: client.id }))
				),
				0
			);
			assert.throws(() => completeInternalNoteEffects(s, client, incident, n, users));
			assert.equal(
				buildIncidentNotification({ type: 'incident_comment', incident, actor: tech, message: n }),
				null
			);
		});
		await t.test(
			'Historial filtra permiso específico, inactivos, organización e incidencia',
			() => {
				const [s, n] = saved();
				const { history } = complete(s, n);
				const event = history[0];
				assert.deepEqual(
					visibleIncidentHistory(tech, incident, [
						event,
						{ ...event, id: 'other', incidentId: 99 },
						{ ...event, id: 'foreign', organizationId: 'foreign' }
					]),
					[event]
				);
				assert.deepEqual(visibleIncidentHistory({ ...tech, active: false }, incident, history), []);
				assert.deepEqual(
					visibleIncidentHistory({ ...tech, organizationId: 'foreign' }, incident, history),
					[]
				);
				const previous = rolePermissions.technician;
				try {
					rolePermissions.technician = previous.filter(
						(p) => p !== 'incidents:view_internal_notes'
					);
					assert.deepEqual(visibleIncidentHistory(tech, incident, history), []);
				} finally {
					rolePermissions.technician = previous;
				}
				for (const fields of [
					{ comment: 'secret' },
					{ reason: 'secret' },
					{ previousValue: { messageId: n.id } },
					{ newValue: { messageId: n.id, content: 'secret' } },
					{ newValue: undefined }
				])
					assert.equal(isIncidentHistory([{ ...event, ...fields }]), false);
			}
		);
		await t.test(
			'No registra eventos falsificados, notas inexistentes ni recuperación pendiente',
			() => {
				const [s, n] = saved();
				for (const forged of [
					{ ...n, content: 'changed' },
					{ ...n, authorUserId: other.id },
					{ ...n, organizationId: 'foreign' },
					{ ...n, incidentId: 99 }
				])
					assert.throws(() => complete(s, forged));
				assert.throws(() => complete(store(), n));
				s.setItem(RECOVERY_KEY, 'pending');
				assert.throws(() => complete(s, n));
				assert.equal(s.getItem(HISTORY_KEY), null);
			}
		);
		await t.test(
			'Destinatarios: asignado autorizado; no autor, cliente, inactivo, ajeno o sin asignar',
			() => {
				for (const assignee of [tech.id, client.id, undefined, 'missing']) {
					const ticket = { ...incident, assignedToUserId: assignee };
					const [s, n] = saved(ticket);
					complete(s, n, ticket);
					assert.equal(s.getItem(NOTIFICATIONS_KEY), null);
				}
				for (const override of [{ active: false }, { organizationId: 'foreign' }]) {
					const [s, n] = saved();
					complete(
						s,
						n,
						incident,
						users.map((u) => (u.id === other.id ? { ...u, ...override } : u))
					);
					assert.equal(s.getItem(NOTIFICATIONS_KEY), null);
				}
			}
		);
		await t.test('Fallo de escritura de nota no crea evento ni éxito', () => {
			const s = store();
			s.fail(MESSAGES_KEY);
			assert.throws(() => appendMessage(s, tech, incident, note(), null));
			assert.equal(s.getItem(MESSAGES_KEY), null);
			assert.equal(s.getItem(HISTORY_KEY), null);
		});
		await t.test('Fallo de historial conserva nota; reintento recupera sin duplicarla', () => {
			const [s, n] = saved();
			s.fail(HISTORY_KEY);
			assert.throws(() => complete(s, n));
			assert.equal(loadMessages(s.getItem(MESSAGES_KEY)).length, 1);
			assert.equal(s.getItem(NOTIFICATIONS_KEY), null);
			s.fail(null);
			complete(s, n);
			complete(s, n);
			assert.equal(JSON.parse(s.getItem(HISTORY_KEY)).length, 1);
		});
		await t.test('Fallo de notificación conserva nota/evento; reintento no duplica', () => {
			const [s, n] = saved();
			s.fail(NOTIFICATIONS_KEY);
			assert.throws(() => complete(s, n));
			assert.equal(JSON.parse(s.getItem(HISTORY_KEY)).length, 1);
			s.fail(null);
			complete(s, n);
			complete(s, n);
			assert.equal(JSON.parse(s.getItem(NOTIFICATIONS_KEY)).length, 1);
			assert.equal(JSON.parse(s.getItem(HISTORY_KEY)).length, 1);
		});
		await t.test('Datos secundarios corruptos no se sobrescriben', () => {
			for (const key of [HISTORY_KEY, NOTIFICATIONS_KEY]) {
				const [s, n] = saved();
				s.setItem(key, 'broken');
				assert.throws(() => complete(s, n));
				assert.equal(s.getItem(key), 'broken');
				assert.equal(loadMessages(s.getItem(MESSAGES_KEY)).length, 1);
			}
		});
		await t.test('Snapshot concurrente rechaza una nota sin perder la anterior', () => {
			const [s, n] = saved();
			const raw = s.getItem(MESSAGES_KEY);
			assert.throws(() => appendMessage(s, tech, incident, note(), null));
			assert.equal(s.getItem(MESSAGES_KEY), raw);
			assert.deepEqual(loadMessages(raw), [n]);
		});
		await t.test('Regresión: nota y evento no alteran SLA ni atención pendiente', () => {
			const s = store();
			const n = note();
			const ticket = { ...incident, sla: { firstRespondedAt: null } };
			const raw = JSON.stringify([ticket]);
			s.setItem(INCIDENTS_KEY, raw);
			const result = sendIncidentMessage(s, tech, ticket, n, null, [ticket], raw);
			const { history } = complete(s, n, ticket);
			assert.equal(result.updatedIncident, undefined);
			assert.equal(s.getItem(INCIDENTS_KEY), raw);
			const publicMessage = {
				...n,
				id: 'client-message',
				visibility: 'public',
				authorUserId: client.id,
				createdAt: '2026-09-17T01:00:00.000Z'
			};
			assert.equal(
				getClientPendingResponseTimestamp(ticket, [publicMessage, n], users, history),
				Date.parse(publicMessage.createdAt)
			);
		});
		await t.test(
			'Vista renderizada: pestañas por rol y notas cerradas de solo lectura',
			async () => {
				const { default: Component } = await mod('components/IncidentMessages.svelte');
				const { render } = await server.ssrLoadModule('svelte/server');
				const props = { incident, users, history: [], categories: [], teams: [] };
				const clientHtml = render(Component, { props: { ...props, actor: client } }).body;
				assert.ok(!clientHtml.includes('message-tab-internal'));
				assert.ok(!clientHtml.includes('message-tab-history'));
				assert.ok(clientHtml.includes('message-tab-public'));
				const staffHtml = render(Component, { props: { ...props, actor: tech } }).body;
				assert.ok(staffHtml.includes('message-tab-internal'));
				assert.ok(staffHtml.includes('4000'));
				const closedHtml = render(Component, {
					props: { ...props, actor: tech, incident: { ...incident, status: 'closed' } }
				}).body;
				assert.ok(closedHtml.includes('Notas de solo lectura'));
			}
		);
	} finally {
		await server.close();
	}
});
