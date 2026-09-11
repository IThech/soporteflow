import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('Notificaciones v1: modelo, eventos de dominio, persistencia, aislamiento y SLA dinámico', async (t) => {
	const server = await createServer({ server: { middlewareMode: true } });

	try {
		const {
			buildIncidentNotification,
			filterUserNotifications,
			countUnreadNotifications,
			markNotificationAsRead,
			markAllNotificationsAsRead,
			clearUserNotifications,
			deriveDynamicSlaAlerts
		} = await server.ssrLoadModule('/src/lib/incidents/notifications.ts');

		const {
			NOTIFICATIONS_KEY,
			isNotification,
			isNotificationList,
			loadNotificationsResult,
			loadNotifications,
			saveNotifications
		} = await server.ssrLoadModule('/src/lib/storage/notifications.ts');

		const { demoUsers: users } = await server.ssrLoadModule('/src/lib/data/users.ts');
		const orgA = 'org-nodhouses';
		const orgB = 'org-other';

		const adminA = users.find((u) => u.role === 'organization_admin');
		const techA = users.find((u) => u.role === 'technician');
		const otherTechA = users.find((u) => u.role === 'technician' && u.id !== techA.id);
		const clientA = users.find((u) => u.role === 'client');
		const platformAdmin = users.find((u) => u.role === 'platform_admin');

		const baseIncident = {
			id: 10,
			organizationId: orgA,
			title: 'Fallo de acceso al servidor',
			client: 'Empresa Test',
			clientUserId: clientA.id,
			assignedToUserId: techA.id,
			status: 'open',
			priority: 'high',
			createdAt: '2026-09-11T10:00:00.000Z'
		};

		function createMockStorage(initial = null) {
			const map = new Map(initial === null ? [] : [[NOTIFICATIONS_KEY, initial]]);
			return {
				getItem: (key) => map.get(key) ?? null,
				setItem: (key, val) => map.set(key, String(val)),
				removeItem: (key) => map.delete(key)
			};
		}

		// -------------------------------------------------------------
		// 1. ASIGNACIÓN Y REASIGNACIÓN
		// -------------------------------------------------------------
		await t.test(
			'1. Asignación: notifica al técnico asignado cuando lo asigna otra persona',
			() => {
				const notification = buildIncidentNotification({
					type: 'incident_assigned',
					incident: { ...baseIncident, assignedToUserId: null },
					newAssigneeId: techA.id,
					actor: adminA,
					reason: 'Carga de trabajo balanceada'
				});

				assert.ok(notification);
				assert.equal(notification.recipientUserId, techA.id);
				assert.equal(notification.type, 'incident_assigned');
				assert.equal(notification.incidentId, 10);
				assert.ok(notification.title.includes('#10'));
				assert.ok(notification.message.includes('Carga de trabajo'));
				assert.equal(notification.readAt, null);
			}
		);

		await t.test('2. Asignación: técnico que se autoasigna NO recibe notificación propia', () => {
			const notification = buildIncidentNotification({
				type: 'incident_assigned',
				incident: { ...baseIncident, assignedToUserId: null },
				newAssigneeId: techA.id,
				actor: techA // autoasignación
			});

			assert.equal(notification, null);
		});

		await t.test('3. Reasignación: notifica al nuevo técnico responsable', () => {
			const notification = buildIncidentNotification({
				type: 'incident_reassigned',
				incident: baseIncident,
				newAssigneeId: otherTechA.id,
				actor: techA,
				reason: 'Derivación por especialidad'
			});

			assert.ok(notification);
			assert.equal(notification.recipientUserId, otherTechA.id);
			assert.equal(notification.type, 'incident_reassigned');
			assert.ok(notification.title.includes('#10'));
			assert.ok(notification.message.includes('Derivación por especialidad'));
		});

		// -------------------------------------------------------------
		// 2. ESCALADO
		// -------------------------------------------------------------
		await t.test('4. Escalado: si cambia el responsable, notifica al nuevo técnico', () => {
			const notification = buildIncidentNotification({
				type: 'incident_escalated',
				incident: baseIncident,
				newAssigneeId: otherTechA.id,
				actor: adminA,
				reason: 'Escalado a N2'
			});

			assert.ok(notification);
			assert.equal(notification.recipientUserId, otherTechA.id);
			assert.equal(notification.type, 'incident_escalated');
			assert.ok(notification.message.includes('Escalado a N2'));
		});

		await t.test('5. Escalado: si solo cambia nivel/equipo, notifica al técnico actual', () => {
			const notification = buildIncidentNotification({
				type: 'incident_escalated',
				incident: baseIncident, // assigned to techA
				actor: adminA,
				reason: 'Cambio de equipo de soporte'
			});

			assert.ok(notification);
			assert.equal(notification.recipientUserId, techA.id);
			assert.equal(notification.type, 'incident_escalated');
		});

		await t.test('6. Escalado sin técnico asignado: no genera notificación huérfana', () => {
			const notification = buildIncidentNotification({
				type: 'incident_escalated',
				incident: { ...baseIncident, assignedToUserId: null },
				actor: adminA,
				reason: 'Escalado preventivo'
			});

			assert.equal(notification, null);
		});

		// -------------------------------------------------------------
		// 3. COMENTARIOS Y NOTAS INTERNAS
		// -------------------------------------------------------------
		await t.test('7. Comentario de cliente: notifica al técnico responsable', () => {
			const message = {
				id: 'msg-1',
				organizationId: orgA,
				incidentId: 10,
				authorUserId: clientA.id,
				visibility: 'public',
				content: 'Sigue fallando tras reiniciar el router.',
				createdAt: '2026-09-11T10:15:00.000Z'
			};

			const notification = buildIncidentNotification({
				type: 'incident_comment',
				incident: baseIncident,
				actor: clientA,
				message
			});

			assert.ok(notification);
			assert.equal(notification.recipientUserId, techA.id);
			assert.equal(notification.type, 'incident_comment');
			assert.ok(notification.message.includes('Sigue fallando'));
		});

		await t.test('8. Comentario de técnico/admin: notifica al cliente propietario', () => {
			const message = {
				id: 'msg-2',
				organizationId: orgA,
				incidentId: 10,
				authorUserId: techA.id,
				visibility: 'public',
				content: 'Hemos revisado los puertos y están abiertos.',
				createdAt: '2026-09-11T10:20:00.000Z'
			};

			const notification = buildIncidentNotification({
				type: 'incident_comment',
				incident: baseIncident,
				actor: techA,
				message
			});

			assert.ok(notification);
			assert.equal(notification.recipientUserId, clientA.id);
			assert.equal(notification.type, 'incident_comment');
			assert.ok(notification.message.includes('revisado los puertos'));
		});

		await t.test('9. Comentario en incidencia sin cliente asociado: no notifica a nadie', () => {
			const message = {
				id: 'msg-3',
				organizationId: orgA,
				incidentId: 10,
				authorUserId: techA.id,
				visibility: 'public',
				content: 'Prueba de mensaje.',
				createdAt: '2026-09-11T10:20:00.000Z'
			};

			const notification = buildIncidentNotification({
				type: 'incident_comment',
				incident: { ...baseIncident, clientUserId: undefined },
				actor: techA,
				message
			});

			assert.equal(notification, null);
		});

		await t.test('10. Nota interna: notifica al técnico responsable si el autor es otro', () => {
			const message = {
				id: 'msg-4',
				organizationId: orgA,
				incidentId: 10,
				authorUserId: adminA.id,
				visibility: 'internal',
				content: 'Ojo, el cliente tiene SLA crítico.',
				createdAt: '2026-09-11T10:25:00.000Z'
			};

			const notification = buildIncidentNotification({
				type: 'incident_internal_note',
				incident: baseIncident,
				actor: adminA,
				message
			});

			assert.ok(notification);
			assert.equal(notification.recipientUserId, techA.id);
			assert.equal(notification.type, 'incident_internal_note');
			assert.ok(notification.message.includes('SLA crítico'));
		});

		await t.test('11. Nota interna creada por el propio técnico: no genera notificación', () => {
			const message = {
				id: 'msg-5',
				organizationId: orgA,
				incidentId: 10,
				authorUserId: techA.id,
				visibility: 'internal',
				content: 'Mis propias notas.',
				createdAt: '2026-09-11T10:25:00.000Z'
			};

			const notification = buildIncidentNotification({
				type: 'incident_internal_note',
				incident: baseIncident,
				actor: techA,
				message
			});

			assert.equal(notification, null);
		});

		// -------------------------------------------------------------
		// 4. ESTADOS, RESOLUCIÓN Y REAPERTURA
		// -------------------------------------------------------------
		await t.test('12. Incidencia resuelta: notifica al cliente asociado', () => {
			const notification = buildIncidentNotification({
				type: 'incident_resolved',
				incident: baseIncident,
				actor: techA
			});

			assert.ok(notification);
			assert.equal(notification.recipientUserId, clientA.id);
			assert.equal(notification.type, 'incident_resolved');
			assert.ok(notification.title.includes('resuelta'));
		});

		await t.test('13. Incidencia reabierta: notifica al técnico responsable', () => {
			const notification = buildIncidentNotification({
				type: 'incident_reopened',
				incident: { ...baseIncident, status: 'resolved' },
				actor: clientA
			});

			assert.ok(notification);
			assert.equal(notification.recipientUserId, techA.id);
			assert.equal(notification.type, 'incident_reopened');
			assert.ok(notification.title.includes('reabierta'));
		});

		await t.test('14. Cambio ordinario de estado (open -> pending): notifica al cliente', () => {
			const notification = buildIncidentNotification({
				type: 'incident_status_changed',
				incident: baseIncident,
				actor: techA,
				nextStatus: 'pending'
			});

			assert.ok(notification);
			assert.equal(notification.recipientUserId, clientA.id);
			assert.equal(notification.type, 'incident_status_changed');
			assert.ok(notification.message.includes('pendiente'));
		});

		// -------------------------------------------------------------
		// 5. AISLAMIENTO Y PERMISOS
		// -------------------------------------------------------------
		await t.test('15. Aislamiento por usuario y organización', () => {
			const notifTechA = {
				id: 'n-1',
				organizationId: orgA,
				recipientUserId: techA.id,
				type: 'incident_assigned',
				incidentId: 1,
				title: 'Caso A',
				message: 'Msg A',
				createdAt: '2026-09-11T10:00:00.000Z',
				readAt: null
			};
			const notifOtherTechA = {
				id: 'n-2',
				organizationId: orgA,
				recipientUserId: otherTechA.id,
				type: 'incident_assigned',
				incidentId: 2,
				title: 'Caso B',
				message: 'Msg B',
				createdAt: '2026-09-11T10:01:00.000Z',
				readAt: null
			};
			const notifOrgB = {
				id: 'n-3',
				organizationId: orgB,
				recipientUserId: techA.id,
				type: 'incident_assigned',
				incidentId: 3,
				title: 'Caso C',
				message: 'Msg C',
				createdAt: '2026-09-11T10:02:00.000Z',
				readAt: null
			};

			const all = [notifTechA, notifOtherTechA, notifOrgB];

			// techA solo ve n-1
			const visibleToTechA = filterUserNotifications(techA, all);
			assert.equal(visibleToTechA.length, 1);
			assert.equal(visibleToTechA[0].id, 'n-1');

			// otherTechA solo ve n-2
			const visibleToOther = filterUserNotifications(otherTechA, all);
			assert.equal(visibleToOther.length, 1);
			assert.equal(visibleToOther[0].id, 'n-2');
		});

		await t.test('16. Cliente jamás recibe notas internas (defensa en profundidad)', () => {
			const leakedInternal = {
				id: 'n-bad',
				organizationId: orgA,
				recipientUserId: clientA.id,
				type: 'incident_internal_note',
				incidentId: 10,
				title: 'Nota interna secreta',
				message: 'Contenido técnico',
				createdAt: '2026-09-11T10:00:00.000Z',
				readAt: null
			};

			const visible = filterUserNotifications(clientA, [leakedInternal]);
			assert.equal(visible.length, 0);
		});

		await t.test('17. Admin no es destinatario automático de eventos de otros', () => {
			const notifTechA = {
				id: 'n-1',
				organizationId: orgA,
				recipientUserId: techA.id,
				type: 'incident_assigned',
				incidentId: 1,
				title: 'Caso',
				message: 'Msg',
				createdAt: '2026-09-11T10:00:00.000Z',
				readAt: null
			};

			const adminVisible = filterUserNotifications(adminA, [notifTechA]);
			assert.equal(adminVisible.length, 0);
		});

		// -------------------------------------------------------------
		// 6. ESTADO DE LECTURA
		// -------------------------------------------------------------
		await t.test('18. Lectura individual y marcar todas como leídas', () => {
			const n1 = {
				id: 'n-1',
				organizationId: orgA,
				recipientUserId: techA.id,
				type: 'incident_assigned',
				incidentId: 1,
				title: 'Uno',
				message: 'Msg',
				createdAt: '2026-09-11T10:00:00.000Z',
				readAt: null
			};
			const n2 = {
				id: 'n-2',
				organizationId: orgA,
				recipientUserId: techA.id,
				type: 'incident_comment',
				incidentId: 2,
				title: 'Dos',
				message: 'Msg',
				createdAt: '2026-09-11T10:05:00.000Z',
				readAt: null
			};

			let list = [n1, n2];
			assert.equal(countUnreadNotifications(techA, list), 2);

			list = markNotificationAsRead(list, 'n-1', '2026-09-11T10:10:00.000Z');
			assert.equal(countUnreadNotifications(techA, list), 1);
			assert.equal(list[0].readAt, '2026-09-11T10:10:00.000Z');
			assert.equal(list[1].readAt, null);

			list = markAllNotificationsAsRead(list, techA.id, orgA, '2026-09-11T10:15:00.000Z');
			assert.equal(countUnreadNotifications(techA, list), 0);
			assert.equal(list[1].readAt, '2026-09-11T10:15:00.000Z');
		});

		// -------------------------------------------------------------
		// 7. PERSISTENCIA Y CONFLICTOS
		// -------------------------------------------------------------
		await t.test('19. Persistencia: lista vacía guardada explícitamente es válida', () => {
			const storage = createMockStorage('[]');
			const result = loadNotificationsResult(storage.getItem(NOTIFICATIONS_KEY));
			assert.equal(result.status, 'valid');
			assert.deepEqual(result.notifications, []);
		});

		await t.test('20. Persistencia: datos corruptos devuelven error y no se sobrescriben', () => {
			const storage = createMockStorage('{"broken": json');
			const result = loadNotificationsResult(storage.getItem(NOTIFICATIONS_KEY));
			assert.equal(result.status, 'corrupt');
			assert.ok(result.error);
			// El almacenamiento permanece con los datos rotos sin ser pisados
			assert.equal(storage.getItem(NOTIFICATIONS_KEY), '{"broken": json');
			assert.throws(() => loadNotifications(storage.getItem(NOTIFICATIONS_KEY)));
		});

		await t.test('21. Persistencia: conflicto de concurrencia entre pestañas detectado', () => {
			const storage = createMockStorage('[]');
			const notif = {
				id: 'n-1',
				organizationId: orgA,
				recipientUserId: techA.id,
				type: 'incident_assigned',
				incidentId: 1,
				title: 'Uno',
				message: 'Msg',
				createdAt: '2026-09-11T10:00:00.000Z',
				readAt: null
			};

			// Si otra pestaña cambió el storage
			storage.setItem(NOTIFICATIONS_KEY, JSON.stringify([notif]));

			// Guardar con expectedRaw '[]' debe fallar
			assert.throws(() => saveNotifications(storage, [notif], '[]'), /otra pestaña/);
		});

		await t.test('21b. Validadores de esquema isNotification e isNotificationList', () => {
			assert.equal(isNotification(null), false);
			assert.equal(isNotification({}), false);
			assert.equal(isNotificationList([]), true);
		});

		// -------------------------------------------------------------
		// 8. SLA DINÁMICO
		// -------------------------------------------------------------
		await t.test(
			'22. SLA dinámico: detecta approaching y breached para incidencias asignadas',
			() => {
				const now = new Date('2026-09-11T12:00:00.000Z');

				const incidentApproaching = {
					id: 8,
					organizationId: orgA,
					title: 'Servidor lento',
					client: 'Cliente 8',
					clientUserId: clientA.id,
					assignedToUserId: techA.id,
					status: 'open',
					priority: 'high',
					createdAt: '2026-09-11T11:00:00.000Z',
					sla: {
						policyId: 'p-1',
						policyName: 'SLA Alta',
						firstResponseMinutes: 70,
						resolutionMinutes: 240,
						firstResponseDueAt: '2026-09-11T12:10:00.000Z', // faltan 10 min -> approaching (warning <= 15m)
						resolutionDueAt: '2026-09-11T15:00:00.000Z',
						firstRespondedAt: null,
						resolvedAt: null
					}
				};

				const incidentBreached = {
					id: 5,
					organizationId: orgA,
					title: 'Caída de red',
					client: 'Cliente 5',
					clientUserId: clientA.id,
					assignedToUserId: techA.id,
					status: 'open',
					priority: 'high',
					createdAt: '2026-09-11T09:00:00.000Z',
					sla: {
						policyId: 'p-1',
						policyName: 'SLA Alta',
						firstResponseMinutes: 60,
						resolutionMinutes: 120,
						firstResponseDueAt: '2026-09-11T10:00:00.000Z', // vencido
						resolutionDueAt: '2026-09-11T11:00:00.000Z', // vencido
						firstRespondedAt: '2026-09-11T09:30:00.000Z', // respuesta cumplida
						resolvedAt: null // resolución incumplida
					}
				};

				const alerts = deriveDynamicSlaAlerts(techA, [incidentApproaching, incidentBreached], now);

				assert.equal(alerts.length, 2);

				const breachedAlert = alerts.find((a) => a.stage === 'breached');
				assert.ok(breachedAlert);
				assert.equal(breachedAlert.incidentId, 5);
				assert.equal(breachedAlert.target, 'resolution');
				assert.ok(breachedAlert.title.includes('incumplido'));

				const approachingAlert = alerts.find((a) => a.stage === 'approaching');
				assert.ok(approachingAlert);
				assert.equal(approachingAlert.incidentId, 8);
				assert.equal(approachingAlert.target, 'first_response');
				assert.ok(approachingAlert.title.includes('próximo a vencer'));
				assert.ok(approachingAlert.message.includes('10'));
			}
		);

		await t.test('23. SLA dinámico: incidencias ya cumplidas/resueltas no generan avisos', () => {
			const now = new Date('2026-09-11T12:00:00.000Z');
			const resolvedIncident = {
				id: 9,
				organizationId: orgA,
				title: 'Caso resuelto',
				client: 'Cliente 9',
				clientUserId: clientA.id,
				assignedToUserId: techA.id,
				status: 'resolved',
				priority: 'high',
				createdAt: '2026-09-11T08:00:00.000Z',
				sla: {
					policyId: 'p-1',
					policyName: 'SLA Alta',
					firstResponseMinutes: 60,
					resolutionMinutes: 120,
					firstResponseDueAt: '2026-09-11T09:00:00.000Z',
					resolutionDueAt: '2026-09-11T10:00:00.000Z',
					firstRespondedAt: '2026-09-11T08:30:00.000Z',
					resolvedAt: '2026-09-11T09:45:00.000Z'
				}
			};

			const alerts = deriveDynamicSlaAlerts(techA, [resolvedIncident], now);
			assert.equal(alerts.length, 0);
		});

		await t.test(
			'24. SLA dinámico: técnico no recibe avisos de incidencias asignadas a otro técnico',
			() => {
				const now = new Date('2026-09-11T12:00:00.000Z');
				const incidentOtherTech = {
					id: 11,
					organizationId: orgA,
					title: 'Caso ajeno',
					client: 'Cliente 11',
					clientUserId: clientA.id,
					assignedToUserId: otherTechA.id, // otro técnico
					status: 'open',
					priority: 'high',
					createdAt: '2026-09-11T09:00:00.000Z',
					sla: {
						policyId: 'p-1',
						policyName: 'SLA Alta',
						firstResponseMinutes: 60,
						resolutionMinutes: 120,
						firstResponseDueAt: '2026-09-11T10:00:00.000Z',
						resolutionDueAt: '2026-09-11T11:00:00.000Z',
						firstRespondedAt: null,
						resolvedAt: null
					}
				};

				const alerts = deriveDynamicSlaAlerts(techA, [incidentOtherTech], now);
				assert.equal(alerts.length, 0);
			}
		);

		await t.test(
			'25. SLA dinámico: platform_admin tiene visibilidad de incidencias para supervisión',
			() => {
				const now = new Date('2026-09-11T12:00:00.000Z');
				const incidentUnassigned = {
					id: 12,
					organizationId: orgA,
					title: 'Incidencia sin asignar vencida',
					client: 'Cliente 12',
					status: 'open',
					priority: 'high',
					createdAt: '2026-09-11T09:00:00.000Z',
					sla: {
						policyId: 'p-1',
						policyName: 'SLA Alta',
						firstResponseMinutes: 60,
						resolutionMinutes: 120,
						firstResponseDueAt: '2026-09-11T10:00:00.000Z',
						resolutionDueAt: '2026-09-11T11:00:00.000Z',
						firstRespondedAt: null,
						resolvedAt: null
					}
				};

				const alerts = deriveDynamicSlaAlerts(platformAdmin, [incidentUnassigned], now);
				assert.equal(alerts.length, 2);
			}
		);

		await t.test(
			'26. Regresión: independencia total entre IDs de incidencias y notificaciones',
			() => {
				// Generar notificación para incidencia con ID numérico (ej. 99)
				const notif = buildIncidentNotification({
					type: 'incident_assigned',
					incident: { ...baseIncident, id: 99, assignedToUserId: null },
					newAssigneeId: techA.id,
					actor: adminA
				});

				assert.ok(notif);
				// 1. El ID de la notificación es un UUID string independiente, no un número ni derivado del ID de la incidencia
				assert.equal(typeof notif.id, 'string');
				assert.match(notif.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
				assert.notEqual(notif.id, '99');
				assert.notEqual(notif.id, 99);

				// 2. La incidencia a la que apunta se mantiene como clave foránea numérica
				assert.equal(notif.incidentId, 99);

				// 3. Dos notificaciones consecutivas para la misma incidencia tienen IDs únicos e independientes
				const notif2 = buildIncidentNotification({
					type: 'incident_reopened',
					incident: { ...baseIncident, id: 99, status: 'resolved' },
					actor: clientA
				});
				assert.ok(notif2);
				assert.notEqual(notif.id, notif2.id);
			}
		);

		await t.test(
			'27. Limpiar notificaciones: borra solo notificaciones persistidas del usuario y org activa, respetando aislamiento multi-usuario y multi-tenant',
			() => {
				const nTech1 = {
					id: 'n-1',
					organizationId: orgA,
					recipientUserId: techA.id,
					type: 'incident_assigned',
					incidentId: 10,
					title: 'Asignada a Tech A',
					message: 'Detalle',
					createdAt: '2026-09-11T10:00:00.000Z',
					readAt: null
				};
				const nTech2 = {
					id: 'n-2',
					organizationId: orgA,
					recipientUserId: otherTechA.id,
					type: 'incident_assigned',
					incidentId: 11,
					title: 'Asignada a Tech 2',
					message: 'Detalle',
					createdAt: '2026-09-11T10:05:00.000Z',
					readAt: null
				};
				const nClient = {
					id: 'n-3',
					organizationId: orgA,
					recipientUserId: clientA.id,
					type: 'incident_resolved',
					incidentId: 10,
					title: 'Resuelta para cliente',
					message: 'Detalle',
					createdAt: '2026-09-11T10:10:00.000Z',
					readAt: '2026-09-11T10:15:00.000Z'
				};
				const nOtherOrg = {
					id: 'n-4',
					organizationId: orgB,
					recipientUserId: techA.id, // Mismo ID de usuario pero en otra organización
					type: 'incident_assigned',
					incidentId: 50,
					title: 'Notificación otra org',
					message: 'Detalle',
					createdAt: '2026-09-11T10:20:00.000Z',
					readAt: null
				};

				const allNotifications = [nTech1, nTech2, nClient, nOtherOrg];

				// Verificar estado inicial
				assert.equal(filterUserNotifications(techA, allNotifications).length, 1);
				assert.equal(countUnreadNotifications(techA, allNotifications), 1);

				// Limpiar notificaciones de techA para orgA
				const cleared = clearUserNotifications(allNotifications, techA.id, orgA);

				// Solo nTech1 debe ser eliminada
				assert.equal(cleared.length, 3);
				assert.equal(
					cleared.some((n) => n.id === 'n-1'),
					false
				);
				assert.equal(
					cleared.some((n) => n.id === 'n-2'),
					true
				);
				assert.equal(
					cleared.some((n) => n.id === 'n-3'),
					true
				);
				assert.equal(
					cleared.some((n) => n.id === 'n-4'),
					true
				);

				// Para techA en orgA, ahora tiene 0 notificaciones
				assert.equal(filterUserNotifications(techA, cleared).length, 0);
				assert.equal(countUnreadNotifications(techA, cleared), 0);

				// Para otherTechA y clientA no ha cambiado nada
				assert.equal(filterUserNotifications(otherTechA, cleared).length, 1);
				assert.equal(filterUserNotifications(clientA, cleared).length, 1);
			}
		);

		await t.test(
			'28. Limpiar notificaciones NO elimina ni afecta a las alertas dinámicas de SLA',
			() => {
				const now = new Date('2026-09-11T12:00:00.000Z');
				const incidentBreached = {
					...baseIncident,
					id: 20,
					assignedToUserId: techA.id,
					status: 'open',
					sla: {
						policyId: 'p-1',
						policyName: 'SLA Alta',
						firstResponseMinutes: 60,
						resolutionMinutes: 120,
						firstResponseDueAt: '2026-09-11T10:00:00.000Z',
						resolutionDueAt: '2026-09-11T11:00:00.000Z',
						firstRespondedAt: null,
						resolvedAt: null
					}
				};

				const persistedNotif = {
					id: 'p-1',
					organizationId: orgA,
					recipientUserId: techA.id,
					type: 'incident_assigned',
					incidentId: 20,
					title: 'Asignada',
					message: 'Detalle',
					createdAt: '2026-09-11T09:00:00.000Z',
					readAt: null
				};

				let notifications = [persistedNotif];

				// Alertas dinámicas calculadas en memoria
				const initialAlerts = deriveDynamicSlaAlerts(techA, [incidentBreached], now);
				assert.equal(initialAlerts.length, 2);

				// Se limpia el historial persistido
				notifications = clearUserNotifications(notifications, techA.id, orgA);
				assert.equal(notifications.length, 0);

				// Las alertas dinámicas SLA siguen existiendo y derivándose fielmente
				const subsequentAlerts = deriveDynamicSlaAlerts(techA, [incidentBreached], now);
				assert.equal(subsequentAlerts.length, 2);
				assert.equal(subsequentAlerts[0].incidentId, 20);
			}
		);

		await t.test(
			'29. SLA dinámico: incidencia incumplida genera alerta y al eliminarse de la colección ya no genera alerta',
			() => {
				const now = new Date('2026-09-11T12:00:00.000Z');
				const incidentBreached = {
					...baseIncident,
					id: 30,
					assignedToUserId: techA.id,
					status: 'open',
					sla: {
						policyId: 'p-1',
						policyName: 'SLA Alta',
						firstResponseMinutes: 60,
						resolutionMinutes: 120,
						firstResponseDueAt: '2026-09-11T10:00:00.000Z',
						resolutionDueAt: '2026-09-11T11:00:00.000Z',
						firstRespondedAt: null,
						resolvedAt: null
					}
				};

				let incidentList = [incidentBreached];

				// 1. Incidencia incumplida en la colección -> genera alerta dinámica
				const alertsBefore = deriveDynamicSlaAlerts(techA, incidentList, now);
				assert.equal(alertsBefore.length, 2);
				assert.equal(alertsBefore[0].incidentId, 30);

				// 2. Incidencia eliminada de la colección -> ya no genera ninguna alerta dinámica
				incidentList = incidentList.filter((item) => item.id !== 30);
				const alertsAfter = deriveDynamicSlaAlerts(techA, incidentList, now);
				assert.equal(alertsAfter.length, 0);
			}
		);

		await t.test(
			'30. SLA dinámico en modo técnico: no genera alertas para tickets resueltos o cerrados, y las reabiertas vuelven a generar alertas activas',
			() => {
				const now = new Date('2026-09-11T12:00:00.000Z');
				const baseSla = {
					policyId: 'p-1',
					policyName: 'SLA Alta',
					firstResponseMinutes: 60,
					resolutionMinutes: 120,
					firstResponseDueAt: '2026-09-11T10:00:00.000Z',
					resolutionDueAt: '2026-09-11T11:00:00.000Z',
					firstRespondedAt: null,
					resolvedAt: null
				};

				// 30.1 Ticket resuelto (incluso sin haber registrado firstRespondedAt antes de resolver)
				const resolvedIncident = {
					...baseIncident,
					id: 31,
					assignedToUserId: techA.id,
					status: 'resolved',
					resolvedAt: '2026-09-11T10:30:00.000Z',
					sla: { ...baseSla, resolvedAt: '2026-09-11T10:30:00.000Z' }
				};
				assert.equal(deriveDynamicSlaAlerts(techA, [resolvedIncident], now).length, 0);

				// 30.2 Ticket cerrado
				const closedIncident = {
					...baseIncident,
					id: 32,
					assignedToUserId: techA.id,
					status: 'closed',
					resolvedAt: '2026-09-11T10:30:00.000Z',
					closedAt: '2026-09-11T11:30:00.000Z',
					closureType: 'client_confirmed',
					sla: { ...baseSla, resolvedAt: '2026-09-11T10:30:00.000Z' }
				};
				assert.equal(deriveDynamicSlaAlerts(techA, [closedIncident], now).length, 0);

				// 30.3 Ticket reabierto (pasa a status 'open') con SLA de resolución vencido
				const reopenedIncident = {
					...baseIncident,
					id: 33,
					assignedToUserId: techA.id,
					status: 'open',
					resolvedAt: '2026-09-11T10:30:00.000Z',
					sla: { ...baseSla, resolvedAt: '2026-09-11T10:30:00.000Z' }
				};
				const reopenedAlerts = deriveDynamicSlaAlerts(techA, [reopenedIncident], now);
				assert.equal(reopenedAlerts.length, 2); // first_response y resolution ambas activas para atención
				assert.equal(
					reopenedAlerts.some((a) => a.target === 'resolution'),
					true
				);

				// 30.4 Al re-resolverse vuelve a desaparecer toda alerta
				const reResolved = {
					...reopenedIncident,
					status: 'resolved',
					resolvedAt: '2026-09-11T12:00:00.000Z'
				};
				assert.equal(deriveDynamicSlaAlerts(techA, [reResolved], now).length, 0);
			}
		);
	} finally {
		await server.close();
	}
});
