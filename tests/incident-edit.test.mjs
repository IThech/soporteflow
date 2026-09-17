import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createServer } from 'vite';

test('Edición y selector: persistencia confirmada, historial y notificaciones', async (t) => {
	const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
	try {
		const mod = (p) => server.ssrLoadModule(`/src/lib/${p}`);
		const { commitIncidentEdit } = await mod('storage/incident-edit.ts');
		const { canActOnIncident } = await mod('auth/record-access.ts');
		const { buildIncidentNotification } = await mod('incidents/notifications.ts');
		const { saveNotifications, NOTIFICATIONS_KEY } = await mod('storage/notifications.ts');
		const { INCIDENTS_KEY, HISTORY_KEY, RECOVERY_KEY, recoverAssignment } =
			await mod('storage/assignment.ts');
		const { FIRST_RESPONSE_RECOVERY_KEY } = await mod('storage/first-response.ts');
		const { isIncidentHistory } = await mod('incidents/history.ts');
		const { visibleIncidentHistory } = await mod('incidents/timeline.ts');
		const { getClientPendingResponseTimestamp } = await mod('incidents/technician-dashboard.ts');
		const { demoUsers: users } = await mod('data/users.ts');
		const actor = users.find((u) => u.role === 'technician');
		const client = users.find((u) => u.role === 'client');
		const fixed = '2026-09-17T12:00:00.000Z';
		const base = {
			id: 42,
			organizationId: actor.organizationId,
			clientUserId: client.id,
			assignedToUserId: actor.id,
			title: 'Caso',
			client: 'Cliente',
			description: 'Problema',
			solution: 'Solución',
			status: 'open',
			priority: 'medium',
			createdAt: '2026-09-17T08:00:00.000Z',
			supportLevel: 'N1',
			teamId: 'team-1',
			siteId: 'site-1',
			sla: {
				policyId: 'policy',
				policyName: 'SLA',
				firstResponseMinutes: 60,
				resolutionMinutes: 240,
				firstResponseDueAt: '2026-09-17T09:00:00.000Z',
				resolutionDueAt: fixed,
				firstRespondedAt: null,
				resolvedAt: null
			}
		};
		// Execute the actual page handlers after TypeScript transpilation, with isolated browser dependencies.
		// This covers orchestration rather than duplicating it in a mock implementation.
		const page = readFileSync('src/routes/app/+page.svelte', 'utf8')
			.split('<script lang="ts">')[1]
			.split('</script>')[0];
		const ast = ts.createSourceFile(
			'page.ts',
			page,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS
		);
		const names = [
			'persistIncidentEdit',
			'updateIncidentStatus',
			'saveEditedIncident',
			'recordNotification'
		];
		const functions = names
			.map((name) => {
				const fn = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name);
				assert.ok(fn, `Missing handler ${name}`);
				return fn.getText(ast);
			})
			.join('\n');
		const code = ts.transpileModule(
			`
   const {commitIncidentEdit,canActOnIncident,buildIncidentNotification,saveNotifications}=deps;
   let incidentList=seed.incidents, history=seed.history;
   let storedIncidentSnapshot=seed.incidentRaw, storedHistorySnapshot=seed.historyRaw;
   let editingIncident=seed.draft, incidentLoadError='';
   let notificationList=[], notificationSnapshot=null, notificationError='';
   const notificationsReady=seed.notificationsReady ?? true;
   const activeUser=seed.actor, localStorage=seed.storage;
   const alerts=[];const window={alert:message=>alerts.push(message)};
   let refreshed=0;
   function refreshMessages(){refreshed++;}
   function openEditIncident(id){editingIncident={...incidentList.find(item=>item.id===id)};}
   ${functions}
   return {updateIncidentStatus,saveEditedIncident,
    state:()=>({incidentList,history,editingIncident,notificationList,notificationError,alerts,refreshed})};
  `,
			{ compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
		).outputText;
		const factory = new Function('deps', 'seed', code);
		function setup({
			incident = base,
			draft,
			actor: acting = actor,
			fail,
			history = [],
			notificationsReady = true,
			throwNotification = false
		} = {}) {
			const incidentRaw = JSON.stringify([incident]),
				historyRaw = JSON.stringify(history);
			const values = new Map([
				[INCIDENTS_KEY, incidentRaw],
				[HISTORY_KEY, historyRaw]
			]);
			const writes = [];
			let armed = true;
			let harness;
			const storage = {
				getItem: (k) => values.get(k) ?? null,
				setItem(k, v) {
					writes.push(k);
					if (k === INCIDENTS_KEY || k === HISTORY_KEY) {
						assert.deepEqual(
							harness.state().incidentList,
							[incident],
							'Visible list changed before commit'
						);
					}
					if (armed && fail === k) {
						armed = false;
						throw Error('Quota');
					}
					values.set(k, v);
				},
				removeItem(k) {
					if (armed && fail === 'remove') {
						armed = false;
						throw Error('Remove failed');
					}
					values.delete(k);
				}
			};
			let built = 0;
			harness = factory(
				{
					commitIncidentEdit,
					canActOnIncident,
					saveNotifications,
					buildIncidentNotification(input) {
						built++;
						assert.deepEqual(harness.state().incidentList, JSON.parse(values.get(INCIDENTS_KEY)));
						assert.deepEqual(harness.state().history, JSON.parse(values.get(HISTORY_KEY)));
						assert.equal(values.has(RECOVERY_KEY), false);
						if (throwNotification) throw Error('Notification failed');
						return buildIncidentNotification(input);
					}
				},
				{
					incidents: [incident],
					history,
					incidentRaw,
					historyRaw,
					draft: draft ?? { ...incident, status: 'resolved' },
					actor: acting,
					storage,
					notificationsReady
				}
			);
			return { ...harness, storage, values, writes, incidentRaw, historyRaw, built: () => built };
		}
		function invoke(h, entry, status = 'resolved') {
			if (entry === 'selector') {
				const select = { value: status };
				h.updateIncidentStatus(42, { currentTarget: select });
				return select;
			}
			h.saveEditedIncident({ preventDefault() {} });
		}
		for (const entry of ['selector', 'editor']) {
			await t.test(`${entry}: guarda incidencia y un único evento antes de UI/notificación`, () => {
				const h = setup();
				invoke(h, entry);
				const state = h.state();
				assert.equal(state.incidentList[0].status, 'resolved');
				assert.equal(state.history.length, 1);
				assert.equal(state.history[0].eventType, 'resolved');
				assert.equal(isIncidentHistory(state.history), true);
				assert.equal(state.history[0].actorUserId, actor.id);
				assert.equal(state.history[0].organizationId, base.organizationId);
				assert.equal(state.history[0].timestamp, state.incidentList[0].resolvedAt);
				assert.equal(state.notificationList.length, 1);
				assert.equal(h.built(), 1);
				assert.deepEqual(visibleIncidentHistory(client, state.incidentList[0], state.history), []);
				for (const key of ['firstResponseDueAt', 'resolutionDueAt', 'firstRespondedAt', 'policyId'])
					assert.equal(state.incidentList[0].sla[key], base.sla[key]);
				for (const key of ['teamId', 'siteId', 'assignedToUserId', 'supportLevel'])
					assert.equal(state.incidentList[0][key], base[key]);
				if (entry === 'editor') assert.equal(state.editingIncident, null);
			});
			for (const fail of [RECOVERY_KEY, INCIDENTS_KEY, HISTORY_KEY, 'remove']) {
				await t.test(`${entry}: fallo ${fail} conserva datos/borrador y no notifica`, () => {
					const draft = { ...base, status: 'resolved', solution: ' Borrador nuevo ' };
					const h = setup({ fail, draft });
					const select = invoke(h, entry);
					assert.deepEqual(h.state().incidentList, [base]);
					assert.deepEqual(h.state().history, []);
					assert.deepEqual(h.state().editingIncident, draft);
					assert.equal(h.built(), 0);
					assert.equal(h.state().refreshed, 0);
					assert.equal(h.values.get(INCIDENTS_KEY), h.incidentRaw);
					assert.equal(h.values.get(HISTORY_KEY), h.historyRaw);
					assert.equal(h.state().alerts.length, 1);
					if (select) assert.equal(select.value, 'open');
				});
			}
			for (const key of [INCIDENTS_KEY, HISTORY_KEY]) {
				await t.test(`${entry}: conflicto ${key} no sobrescribe ni notifica`, () => {
					const h = setup();
					const changed =
						key === INCIDENTS_KEY ? JSON.stringify([{ ...base, title: 'Otra pestaña' }]) : '[] ';
					h.values.set(key, changed);
					invoke(h, entry);
					assert.deepEqual(h.state().incidentList, [base]);
					assert.equal(h.values.get(key), changed);
					assert.equal(h.built(), 0);
					assert.equal(h.writes.length, 0);
				});
			}
			await t.test(`${entry}: permisos e inactivos, aislamiento por organización`, () => {
				for (const invalid of [
					client,
					{ ...actor, active: false },
					{ ...actor, organizationId: 'foreign' }
				]) {
					const h = setup({ actor: invalid });
					invoke(h, entry);
					assert.deepEqual(h.state().incidentList, [base]);
					assert.equal(h.writes.length, 0);
					assert.equal(h.built(), 0);
				}
			});
			await t.test(
				`${entry}: sin transición no genera historial de estado ni notificaciones`,
				() => {
					const h = setup({ draft: { ...base, title: 'Título editado' } });
					invoke(h, entry, 'open');
					assert.deepEqual(h.state().history, []);
					assert.equal(h.built(), 0);
					if (entry === 'editor') assert.equal(h.state().incidentList[0].title, 'Título editado');
				}
			);
			await t.test(`${entry}: recuperación pendiente bloquea el guardado`, () => {
				for (const key of [RECOVERY_KEY, FIRST_RESPONSE_RECOVERY_KEY]) {
					const h = setup();
					h.values.set(key, 'pending');
					invoke(h, entry);
					assert.deepEqual(h.state().incidentList, [base]);
					assert.equal(h.writes.length, 0);
					assert.equal(h.built(), 0);
				}
			});
			await t.test(`${entry}: fallo secundario de notificación no deshace el guardado`, () => {
				for (const opts of [
					{ fail: NOTIFICATIONS_KEY },
					{ notificationsReady: false },
					{ throwNotification: true }
				]) {
					const h = setup(opts);
					invoke(h, entry);
					assert.equal(h.state().incidentList[0].status, 'resolved');
					assert.equal(h.state().history.length, 1);
					assert.ok(h.state().notificationError);
					assert.equal(h.state().alerts.length, 0);
					if (entry === 'editor') assert.equal(h.state().editingIncident, null);
				}
			});
		}
		await t.test(
			'Editor: matriz de transiciones conserva esquemas, cierre y reapertura existentes',
			() => {
				for (const previous of ['open', 'pending', 'resolved', 'closed'])
					for (const status of ['open', 'pending', 'resolved', 'closed']) {
						const incident = {
							...base,
							status: previous,
							...(['resolved', 'closed'].includes(previous) ? { resolvedAt: fixed } : {}),
							...(previous === 'closed' ? { closedAt: fixed, closureType: 'client_confirmed' } : {})
						};
						const h = setup({ incident, draft: { ...incident, status } });
						invoke(h, 'editor');
						if (status === 'closed' && previous !== 'closed') {
							assert.equal(h.writes.length, 0);
							continue;
						}
						assert.equal(h.state().incidentList[0].status, status);
						if (status === previous) {
							assert.equal(h.state().history.length, 0);
							continue;
						}
						const expected =
							status === 'resolved'
								? 'resolved'
								: ['resolved', 'closed'].includes(previous) && status === 'open'
									? 'reopened'
									: 'status_changed';
						assert.deepEqual(
							h.state().history.map((e) => e.eventType),
							[expected]
						);
						assert.ok(isIncidentHistory(h.state().history));
					}
			}
		);
		await t.test(
			'Validación: solución/descripción requeridas; cierre manual y estado falsificado rechazados',
			() => {
				for (const changes of [
					{ solution: '' },
					{ description: '' },
					{ title: '' },
					{ client: '' },
					{ status: 'closed' },
					{ status: 'bad' }
				]) {
					const h = setup({ draft: { ...base, status: 'resolved', ...changes } });
					invoke(h, 'editor');
					assert.equal(h.writes.length, 0);
					assert.equal(h.built(), 0);
					assert.ok(h.state().editingIncident);
				}
				const h = setup({ incident: { ...base, solution: '' } });
				const select = invoke(h, 'selector');
				assert.equal(select.value, 'open');
				assert.equal(h.state().editingIncident.status, 'resolved');
				assert.equal(h.writes.length, 0);
				assert.equal(h.built(), 0);
			}
		);
		await t.test(
			'Editor: compatibilidad V1/V2, nota histórica y snapshot de clasificación intactos',
			() => {
				const classification = {
					baseCriticality: 'high',
					impactLevel: 'I4',
					matrixPriority: 'critical',
					minPriority: null,
					minPriorityApplied: false,
					calculatedPriority: 'critical',
					effectivePriority: 'critical',
					hasOverride: false
				};
				for (const v2 of [false, true]) {
					const incident = {
						...base,
						priority: 'urgent',
						...(v2 ? { classification, subcategoryId: 'sub' } : {})
					};
					const history = [
						{
							id: 'old-note',
							incidentId: 42,
							organizationId: base.organizationId,
							actorUserId: actor.id,
							timestamp: fixed,
							eventType: 'internal_note_added',
							newValue: { messageId: 'note' }
						}
					];
					const h = setup({
						incident,
						history,
						draft: { ...incident, status: 'pending', priority: 'low' }
					});
					invoke(h, 'editor');
					assert.equal(h.state().incidentList[0].priority, v2 ? 'urgent' : 'low');
					assert.deepEqual(h.state().incidentList[0].classification, incident.classification);
					assert.deepEqual(h.state().history[0], history[0]);
					assert.equal(h.state().history.length, 2);
				}
			}
		);
		await t.test(
			'Resolución alimenta el historial; cambio operativo elimina atención pendiente',
			() => {
				const message = {
					id: 'm',
					organizationId: base.organizationId,
					incidentId: 42,
					authorUserId: client.id,
					visibility: 'public',
					content: 'Seguimiento',
					createdAt: '2026-09-17T08:30:00.000Z'
				};
				assert.notEqual(getClientPendingResponseTimestamp(base, [message], users, []), null);
				const h = setup({ draft: { ...base, status: 'pending' } });
				invoke(h, 'editor');
				assert.equal(
					getClientPendingResponseTimestamp(
						h.state().incidentList[0],
						[message],
						users,
						h.state().history
					),
					null
				);
			}
		);
		await t.test(
			'Recuperación fallida conserva diario y permite restaurar sin notificación falsa',
			() => {
				const h = setup();
				const originalSet = h.storage.setItem;
				let fail = true;
				h.storage.setItem = (k, v) => {
					if (fail && k === HISTORY_KEY) throw Error('Persistent failure');
					originalSet(k, v);
				};
				invoke(h, 'editor');
				assert.equal(h.built(), 0);
				assert.deepEqual(h.state().incidentList, [base]);
				assert.ok(h.values.has(RECOVERY_KEY));
				assert.ok(h.state().editingIncident);
				fail = false;
				recoverAssignment(h.storage);
				assert.equal(h.values.get(INCIDENTS_KEY), h.incidentRaw);
				assert.equal(h.values.get(HISTORY_KEY), h.historyRaw);
				assert.equal(h.values.has(RECOVERY_KEY), false);
			}
		);
	} finally {
		await server.close();
	}
});
