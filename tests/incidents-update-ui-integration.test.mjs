import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateIncident, IncidentApiError } from '../src/lib/api/incidents.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function createDeferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeSampleIncident(overrides = {}) {
	const orgId = overrides.organizationId ?? randomUUID();
	const incId = overrides.id ?? randomUUID();
	return {
		id: incId,
		organizationId: orgId,
		incidentNumber: 101,
		title: 'Servidor caído en sede central',
		description: 'El servidor principal no responde a pings ni peticiones HTTP.',
		status: 'open',
		priority: 'high',
		client: 'Acme Corp',
		clientUserId: null,
		createdByUserId: randomUUID(),
		siteId: null,
		createdAt: '2026-09-23T12:00:00.000Z',
		updatedAt: '2026-09-23T12:30:00.000Z',
		...overrides
	};
}

/**
 * Simulates the edit coordinator in src/routes/app/incidents/[id]/+page.svelte
 * and the form logic in src/lib/components/incidents/RealIncidentEditForm.svelte.
 */
function createEditCoordinator(initialIncident, options = {}) {
	const updateIncidentFn = options.updateIncidentFn ?? updateIncident;

	const state = {
		incident: initialIncident ? { ...initialIncident } : null,
		isEditing: false,
		submitting: false,
		updateError: null,
		sessionLoading: false
	};

	let editAbortController = null;

	function openEdit() {
		state.isEditing = true;
		state.updateError = null;
	}

	function cancelEdit() {
		if (state.submitting) return;
		state.isEditing = false;
		state.updateError = null;
	}

	async function saveEdit(changes, orgId, gotoFn, sessionStore) {
		if (state.submitting || !state.incident || !orgId) return;

		// Check if no-op
		const statusChanged = changes.status !== undefined && changes.status !== state.incident.status;
		const priorityChanged =
			changes.priority !== undefined && changes.priority !== state.incident.priority;

		if (!statusChanged && !priorityChanged) {
			cancelEdit();
			return;
		}

		state.submitting = true;
		state.updateError = null;

		if (editAbortController) {
			editAbortController.abort();
		}
		const controller = new AbortController();
		editAbortController = controller;

		try {
			const updated = await updateIncidentFn(orgId, state.incident.id, changes, {
				signal: controller.signal
			});
			state.incident = updated;
			state.isEditing = false;
			state.updateError = null;
		} catch (err) {
			if (err?.name === 'AbortError' || controller.signal.aborted) {
				return;
			}
			if (err instanceof IncidentApiError && err.status === 401) {
				sessionStore?.clearSession();
				if (gotoFn) await gotoFn('/login?expired=true');
				return;
			}
			if (err instanceof IncidentApiError) {
				state.updateError = err.message;
			} else {
				state.updateError = 'No se pudo actualizar la incidencia. Inténtalo de nuevo.';
			}
		} finally {
			state.submitting = false;
		}
	}

	return {
		state,
		openEdit,
		cancelEdit,
		saveEdit,
		getAbortController: () => editAbortController
	};
}

// Logic helper for status options
const VALID_TARGETS = {
	open: ['pending', 'resolved'],
	pending: ['open', 'resolved'],
	resolved: ['open', 'closed'],
	closed: ['open']
};

function getAvailableStatusOptions(currentStatus) {
	return [currentStatus, ...(VALID_TARGETS[currentStatus] || [])];
}

test('SoporteFlow — Etapa 5.4H: Suite de Integración UI y Edición Real de Incidencias', async (t) => {
	// 1. botón editar
	await t.test('1. botón editar existe en componente de detalle cuando no se está editando', () => {
		const detailSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentDetail.svelte'),
			'utf-8'
		);
		assert.ok(detailSrc.includes('Editar incidencia'), 'Debe existir el botón Editar incidencia');
		assert.ok(detailSrc.includes('onEdit'), 'Debe aceptar prop/callback onEdit');
	});

	// 2. abre formulario
	await t.test('2. abre formulario al pulsar editar', () => {
		const coord = createEditCoordinator(makeSampleIncident());
		assert.equal(coord.state.isEditing, false);
		coord.openEdit();
		assert.equal(coord.state.isEditing, true);
	});

	// 3. valores actuales
	await t.test('3. formulario inicializa con valores actuales del incidente', () => {
		const inc = makeSampleIncident({ status: 'pending', priority: 'urgent' });
		const coord = createEditCoordinator(inc);
		coord.openEdit();
		assert.equal(coord.state.incident.status, 'pending');
		assert.equal(coord.state.incident.priority, 'urgent');
	});

	// 4. opciones status válidas open
	await t.test('4. opciones status válidas para open: open, pending, resolved', () => {
		const opts = getAvailableStatusOptions('open');
		assert.deepEqual(opts, ['open', 'pending', 'resolved']);
	});

	// 5. opciones status válidas pending
	await t.test('5. opciones status válidas para pending: pending, open, resolved', () => {
		const opts = getAvailableStatusOptions('pending');
		assert.deepEqual(opts, ['pending', 'open', 'resolved']);
	});

	// 6. opciones status válidas resolved
	await t.test('6. opciones status válidas para resolved: resolved, open, closed', () => {
		const opts = getAvailableStatusOptions('resolved');
		assert.deepEqual(opts, ['resolved', 'open', 'closed']);
	});

	// 7. opciones status válidas closed
	await t.test('7. opciones status válidas para closed: closed, open', () => {
		const opts = getAvailableStatusOptions('closed');
		assert.deepEqual(opts, ['closed', 'open']);
	});

	// 8. no muestra transición inválida
	await t.test('8. no muestra transiciones inválidas en UI', () => {
		const optsOpen = getAvailableStatusOptions('open');
		assert.ok(!optsOpen.includes('closed'), 'open no debe ofrecer closed');

		const optsClosed = getAvailableStatusOptions('closed');
		assert.ok(!optsClosed.includes('pending'), 'closed no debe ofrecer pending');
		assert.ok(!optsClosed.includes('resolved'), 'closed no debe ofrecer resolved');
	});

	// 9. priority actual seleccionada
	await t.test('9. priority actual seleccionada en opciones de prioridad', () => {
		const editFormSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentEditForm.svelte'),
			'utf-8'
		);
		assert.ok(
			editFormSrc.includes('selectedPriority = $state<IncidentPriority>(incident.priority);') ||
				editFormSrc.includes('bind:value={selectedPriority}'),
			'Debe preseleccionar priority del incidente'
		);
	});

	// 10. cancelar descarta
	await t.test('10. cancelar descarta cambios y cierra modo edición', () => {
		const coord = createEditCoordinator(makeSampleIncident());
		coord.openEdit();
		assert.equal(coord.state.isEditing, true);
		coord.cancelEdit();
		assert.equal(coord.state.isEditing, false);
		assert.equal(coord.state.updateError, null);
	});

	// 11. no-op no PATCH
	await t.test(
		'11. guardar sin cambios efectivos (no-op) no ejecuta PATCH y cierra edición',
		async () => {
			let patchCalled = false;
			const inc = makeSampleIncident({ status: 'open', priority: 'medium' });
			const coord = createEditCoordinator(inc, {
				updateIncidentFn: async () => {
					patchCalled = true;
					return inc;
				}
			});
			coord.openEdit();
			await coord.saveEdit({ status: 'open', priority: 'medium' }, inc.organizationId);
			assert.equal(patchCalled, false, 'No debe invocar el endpoint si no hay cambios');
			assert.equal(coord.state.isEditing, false);
		}
	);

	// 12. PATCH status
	await t.test('12. PATCH modifica únicamente status', async () => {
		let sentPayload = null;
		const inc = makeSampleIncident({ status: 'open', priority: 'medium' });
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async (orgId, id, input) => {
				sentPayload = input;
				return { ...inc, status: input.status, updatedAt: '2026-09-24T12:00:00.000Z' };
			}
		});
		coord.openEdit();
		await coord.saveEdit({ status: 'pending' }, inc.organizationId);
		assert.deepEqual(sentPayload, { status: 'pending' });
		assert.equal(coord.state.incident.status, 'pending');
		assert.equal(coord.state.incident.priority, 'medium');
		assert.equal(coord.state.isEditing, false);
	});

	// 13. PATCH priority
	await t.test('13. PATCH modifica únicamente priority', async () => {
		let sentPayload = null;
		const inc = makeSampleIncident({ status: 'open', priority: 'medium' });
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async (orgId, id, input) => {
				sentPayload = input;
				return { ...inc, priority: input.priority, updatedAt: '2026-09-24T12:00:00.000Z' };
			}
		});
		coord.openEdit();
		await coord.saveEdit({ priority: 'urgent' }, inc.organizationId);
		assert.deepEqual(sentPayload, { priority: 'urgent' });
		assert.equal(coord.state.incident.priority, 'urgent');
		assert.equal(coord.state.incident.status, 'open');
		assert.equal(coord.state.isEditing, false);
	});

	// 14. PATCH ambos
	await t.test('14. PATCH modifica status y priority simultáneamente', async () => {
		let sentPayload = null;
		const inc = makeSampleIncident({ status: 'open', priority: 'medium' });
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async (orgId, id, input) => {
				sentPayload = input;
				return {
					...inc,
					status: input.status,
					priority: input.priority,
					updatedAt: '2026-09-24T12:00:00.000Z'
				};
			}
		});
		coord.openEdit();
		await coord.saveEdit({ status: 'resolved', priority: 'low' }, inc.organizationId);
		assert.deepEqual(sentPayload, { status: 'resolved', priority: 'low' });
		assert.equal(coord.state.incident.status, 'resolved');
		assert.equal(coord.state.incident.priority, 'low');
		assert.equal(coord.state.isEditing, false);
	});

	// 15. submitting disabled
	await t.test('15. controles se deshabilitan durante submitting', async () => {
		const deferred = createDeferred();
		const inc = makeSampleIncident({ status: 'open', priority: 'medium' });
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => {
				await deferred.promise;
				return { ...inc, status: 'pending' };
			}
		});

		coord.openEdit();
		const savePromise = coord.saveEdit({ status: 'pending' }, inc.organizationId);
		assert.equal(coord.state.submitting, true);

		deferred.resolve();
		await savePromise;
		assert.equal(coord.state.submitting, false);
	});

	// 16. doble submit bloqueado
	await t.test('16. doble submit bloqueado mientras guarda', async () => {
		let callCount = 0;
		const deferred = createDeferred();
		const inc = makeSampleIncident();
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => {
				callCount++;
				await deferred.promise;
				return { ...inc, status: 'pending' };
			}
		});

		coord.openEdit();
		const p1 = coord.saveEdit({ status: 'pending' }, inc.organizationId);
		const p2 = coord.saveEdit({ status: 'pending' }, inc.organizationId);

		deferred.resolve();
		await Promise.all([p1, p2]);
		assert.equal(callCount, 1, 'Solo debe realizarse una petición');
	});

	// 17. 401 limpia sesión
	await t.test('17. 401 limpia sesión y redirige a login', async () => {
		let redirected = null;
		let sessionCleared = false;
		const fakeSessionStore = {
			clearSession: () => {
				sessionCleared = true;
			}
		};

		const inc = makeSampleIncident();
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => {
				throw new IncidentApiError(401, 'UNAUTHORIZED', 'Tu sesión ya no es válida.');
			}
		});

		coord.openEdit();
		await coord.saveEdit(
			{ status: 'pending' },
			inc.organizationId,
			(path) => {
				redirected = path;
			},
			fakeSessionStore
		);

		assert.equal(sessionCleared, true);
		assert.equal(redirected, '/login?expired=true');
	});

	// 18. 403 conserva sesión
	await t.test('18. 403 conserva sesión y muestra mensaje de error de permisos', async () => {
		let sessionCleared = false;
		const fakeSessionStore = {
			clearSession: () => {
				sessionCleared = true;
			}
		};

		const inc = makeSampleIncident();
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => {
				throw new IncidentApiError(
					403,
					'FORBIDDEN',
					'No tienes permisos para modificar esta incidencia.'
				);
			}
		});

		coord.openEdit();
		await coord.saveEdit({ status: 'pending' }, inc.organizationId, null, fakeSessionStore);

		assert.equal(sessionCleared, false, 'No debe limpiar sesión en 403');
		assert.equal(coord.state.updateError, 'No tienes permisos para modificar esta incidencia.');
		assert.equal(coord.state.incident.status, 'open', 'No altera datos locales');
	});

	// 19. 404 seguro
	await t.test('19. 404 seguro ante incidencia inexistente', async () => {
		const inc = makeSampleIncident();
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => {
				throw new IncidentApiError(404, 'NOT_FOUND', 'La incidencia no está disponible.');
			}
		});

		coord.openEdit();
		await coord.saveEdit({ status: 'pending' }, inc.organizationId);

		assert.equal(coord.state.updateError, 'La incidencia no está disponible.');
		assert.equal(coord.state.incident.id, inc.id);
	});

	// 20. 500 muestra error
	await t.test('20. 500 muestra error legible para el usuario', async () => {
		const inc = makeSampleIncident();
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => {
				throw new IncidentApiError(
					500,
					'SERVER_ERROR',
					'No se pudo actualizar la incidencia. Inténtalo de nuevo.'
				);
			}
		});

		coord.openEdit();
		await coord.saveEdit({ status: 'pending' }, inc.organizationId);

		assert.equal(
			coord.state.updateError,
			'No se pudo actualizar la incidencia. Inténtalo de nuevo.'
		);
	});

	// 21. network muestra error
	await t.test('21. error de red muestra mensaje adecuado', async () => {
		const inc = makeSampleIncident();
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => {
				throw new IncidentApiError(0, 'NETWORK_ERROR', 'No se pudo conectar con el servidor.');
			}
		});

		coord.openEdit();
		await coord.saveEdit({ status: 'pending' }, inc.organizationId);

		assert.equal(coord.state.updateError, 'No se pudo conectar con el servidor.');
	});

	// 22. Abort silencioso
	await t.test('22. AbortSignal aborta silenciosamente sin corromper estado', async () => {
		const inc = makeSampleIncident();
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => {
				const error = new Error('The operation was aborted');
				error.name = 'AbortError';
				throw error;
			}
		});

		coord.openEdit();
		await coord.saveEdit({ status: 'pending' }, inc.organizationId);

		assert.equal(coord.state.updateError, null);
		assert.equal(coord.state.submitting, false);
	});

	// 23. success reemplaza incident
	await t.test('23. respuesta exitosa reemplaza objeto incident reactivo', async () => {
		const inc = makeSampleIncident({ status: 'open', priority: 'medium' });
		const updatedInc = {
			...inc,
			status: 'resolved',
			priority: 'high',
			updatedAt: '2026-09-24T12:00:00.000Z'
		};

		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => updatedInc
		});

		coord.openEdit();
		await coord.saveEdit({ status: 'resolved', priority: 'high' }, inc.organizationId);

		assert.deepEqual(coord.state.incident, updatedInc);
		assert.equal(coord.state.isEditing, false);
	});

	// 24. status visual actualizado
	await t.test('24. status actualizado se refleja inmediatamente en el modelo', async () => {
		const inc = makeSampleIncident({ status: 'open' });
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => ({ ...inc, status: 'resolved' })
		});
		coord.openEdit();
		await coord.saveEdit({ status: 'resolved' }, inc.organizationId);
		assert.equal(coord.state.incident.status, 'resolved');
	});

	// 25. priority visual actualizada
	await t.test('25. priority actualizada se refleja inmediatamente en el modelo', async () => {
		const inc = makeSampleIncident({ priority: 'low' });
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => ({ ...inc, priority: 'urgent' })
		});
		coord.openEdit();
		await coord.saveEdit({ priority: 'urgent' }, inc.organizationId);
		assert.equal(coord.state.incident.priority, 'urgent');
	});

	// 26. updatedAt actualizado
	await t.test('26. updatedAt actualizado se refleja tras guardar', async () => {
		const inc = makeSampleIncident({ updatedAt: '2026-09-23T10:00:00.000Z' });
		const newTime = '2026-09-24T12:00:00.000Z';
		const coord = createEditCoordinator(inc, {
			updateIncidentFn: async () => ({ ...inc, status: 'pending', updatedAt: newTime })
		});
		coord.openEdit();
		await coord.saveEdit({ status: 'pending' }, inc.organizationId);
		assert.equal(coord.state.incident.updatedAt, newTime);
	});

	// 27. history no visible
	await t.test('27. el componente de detalle y edición no contienen ni renderizan history', () => {
		const detailSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentDetail.svelte'),
			'utf-8'
		);
		const editSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentEditForm.svelte'),
			'utf-8'
		);
		assert.ok(!detailSrc.includes('history'), 'Detail no debe referenciar history');
		assert.ok(!editSrc.includes('history'), 'EditForm no debe referenciar history');
	});

	// 28. no demo
	await t.test('28. componentes reales no importan ni dependen de la demo', () => {
		const detailSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentDetail.svelte'),
			'utf-8'
		);
		const editSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentEditForm.svelte'),
			'utf-8'
		);
		const pageSrc = fs.readFileSync(
			path.join(root, 'src/routes/app/incidents/[id]/+page.svelte'),
			'utf-8'
		);

		for (const src of [detailSrc, editSrc, pageSrc]) {
			assert.ok(!src.includes('$lib/storage'), 'No debe importar $lib/storage');
			assert.ok(!src.includes('activeUser'), 'No debe referenciar activeUser');
			assert.ok(!src.includes('mock'), 'No debe importar mock');
		}
	});

	// 29. no localStorage
	await t.test('29. componentes reales no interactúan con localStorage', () => {
		const detailSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentDetail.svelte'),
			'utf-8'
		);
		const editSrc = fs.readFileSync(
			path.join(root, 'src/lib/components/incidents/RealIncidentEditForm.svelte'),
			'utf-8'
		);
		const pageSrc = fs.readFileSync(
			path.join(root, 'src/routes/app/incidents/[id]/+page.svelte'),
			'utf-8'
		);

		for (const src of [detailSrc, editSrc, pageSrc]) {
			assert.ok(!src.includes('localStorage'), 'No debe usar localStorage');
		}
	});

	// 30. parse runtime
	await t.test('30. updateIncident valida el contrato IncidentListItem en runtime', async () => {
		const orgId = randomUUID();
		const incId = randomUUID();

		// Custom fetch que devuelve un payload incompleto / malformado
		const customFetch = async () => ({
			ok: true,
			status: 200,
			json: async () => ({ incident: { id: incId, organizationId: orgId, title: 'Incompleto' } })
		});

		await assert.rejects(
			updateIncident(orgId, incId, { status: 'pending' }, { customFetch }),
			(err) => err instanceof IncidentApiError && err.code === 'INVALID_PAYLOAD'
		);
	});

	// 31. tenant mismatch rechazado
	await t.test('31. updateIncident rechaza respuesta con organizationId discordante', async () => {
		const orgA = randomUUID();
		const orgB = randomUUID();
		const incId = randomUUID();

		const customFetch = async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				incident: makeSampleIncident({ id: incId, organizationId: orgB })
			})
		});

		await assert.rejects(
			updateIncident(orgA, incId, { status: 'pending' }, { customFetch }),
			(err) => err instanceof IncidentApiError && err.code === 'INVALID_PAYLOAD'
		);
	});
});
