import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { ApiError } from '../src/lib/api/errors.ts';
import {
	createIncidentConversation,
	unauthenticatedConversationError,
	MESSAGE_MAX_LENGTH
} from '../src/lib/app/incident-conversation.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const USER_A = randomUUID();
const INCIDENT_A = randomUUID();
const INCIDENT_B = randomUUID();
const SENTINEL = 'INTERNAL_SECRET_SENTINEL_XYZ987';

function identity(capabilities = ['incidents:view_all'], organizationId = ORG_A, generation = 1) {
	return {
		userId: USER_A,
		organizationId,
		organizationSlug: 'org-test',
		generation,
		capabilities: Object.freeze([...capabilities])
	};
}

function commentItem(id = randomUUID(), body = 'Comentario de prueba', authorName = 'Ana Gestora') {
	return {
		id,
		body,
		createdAt: '2026-09-29T10:00:00.000000Z',
		author: { name: authorName }
	};
}

function noteItem(
	id = randomUUID(),
	body = 'Nota interna de prueba',
	authorName = 'Carlos Técnico'
) {
	return {
		id,
		body,
		createdAt: '2026-09-29T10:05:00.000000Z',
		author: { name: authorName }
	};
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

test('UI-2D-A: carga de comentarios públicos por requester y staff', async () => {
	const calls = [];
	const conv = createIncidentConversation({
		listComments: async (opts) => {
			calls.push(opts);
			return {
				items: [commentItem('c1', 'Hola desde soporte')],
				nextCursor: null
			};
		}
	});

	// 1. Requester carga comentarios públicos
	conv.setTarget({
		identity: identity(['incidents:view_requested']),
		incidentId: INCIDENT_A,
		audience: 'requester',
		capabilities: ['incidents:view_requested']
	});
	await conv.loadComments();

	assert.equal(conv.get().comments.status, 'ready');
	assert.equal(conv.get().comments.items.length, 1);
	assert.equal(conv.get().comments.items[0].body, 'Hola desde soporte');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].incidentId, INCIDENT_A);

	// 2. Staff carga comentarios públicos
	conv.setTarget({
		identity: identity(['incidents:view_all']),
		incidentId: INCIDENT_B,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	await conv.loadComments();

	assert.equal(conv.get().comments.status, 'ready');
	assert.equal(calls.length, 2);
	assert.equal(calls[1].incidentId, INCIDENT_B);

	conv.dispose();
});

test('UI-2D-A: estado vacío y paginación con deduplicación', async () => {
	const conv = createIncidentConversation({
		listComments: async (opts) => {
			if (opts.incidentId === 'empty-inc') {
				return { items: [], nextCursor: null };
			}
			if (!opts.cursor) {
				return {
					items: [commentItem('c1', 'Comentario 1'), commentItem('c2', 'Comentario 2')],
					nextCursor: 'cursor_page_2'
				};
			}
			return {
				items: [commentItem('c2', 'Comentario 2 repetido'), commentItem('c3', 'Comentario 3')],
				nextCursor: null
			};
		}
	});

	// Empty state
	conv.setTarget({
		identity: identity(),
		incidentId: 'empty-inc',
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	await conv.loadComments();
	assert.equal(conv.get().comments.status, 'ready');
	assert.equal(conv.get().comments.items.length, 0);

	// Paginación y deduplicación
	conv.setTarget({
		identity: identity(),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	await conv.loadComments();
	assert.equal(conv.get().comments.items.length, 2);
	assert.equal(conv.get().comments.nextCursor, 'cursor_page_2');

	// Cargar siguiente página
	await conv.loadComments({ reset: false });
	assert.equal(conv.get().comments.items.length, 3);
	assert.deepEqual(
		conv.get().comments.items.map((i) => i.id),
		['c1', 'c2', 'c3']
	);
	assert.equal(conv.get().comments.nextCursor, null);

	conv.dispose();
});

test('UI-2D-A: validación pre-send del composer (whitespace, max 4000)', async () => {
	let sent = 0;
	const conv = createIncidentConversation({
		createComment: async () => {
			sent++;
			return commentItem();
		}
	});

	conv.setTarget({
		identity: identity(),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all', 'incidents:add_comment']
	});

	// Vacío / whitespace
	const emptyRes = await conv.addComment('   ');
	assert.equal(emptyRes.status, 'error');
	assert.equal(emptyRes.error.code, 'INVALID_INPUT');
	assert.equal(sent, 0);

	// Exceso 4000 caracteres
	const longText = 'a'.repeat(MESSAGE_MAX_LENGTH + 1);
	const longRes = await conv.addComment(longText);
	assert.equal(longRes.status, 'error');
	assert.equal(longRes.error.code, 'INVALID_INPUT');
	assert.equal(sent, 0);

	// Exactamente 4000 caracteres
	const exactText = 'a'.repeat(MESSAGE_MAX_LENGTH);
	const okRes = await conv.addComment(exactText);
	assert.equal(okRes.status, 'success');
	assert.equal(sent, 1);

	conv.dispose();
});

test('UI-2D-A: mutación desconocida (unknown) y error preservan borrador sin duplicados', async () => {
	let attempts = 0;
	const conv = createIncidentConversation({
		createComment: async (opts) => {
			attempts++;
			if (attempts === 1) {
				// Gateway timeout 504 -> unknown outcome
				throw new ApiError(504, 'SERVER_ERROR', 'Gateway timeout');
			}
			if (attempts === 2) {
				// 400 invalid input -> definite error
				throw new ApiError(400, 'INVALID_INPUT', 'Error de validación');
			}
			return commentItem('c_ok', opts.body);
		}
	});

	conv.setTarget({
		identity: identity(),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all', 'incidents:add_comment']
	});

	conv.setCommentDraft('Mensaje importante');

	// 1. Unknown outcome (504)
	const res1 = await conv.addComment();
	assert.equal(res1.status, 'unknown');
	assert.equal(
		conv.get().commentComposer.draft,
		'Mensaje importante',
		'preserva borrador en unknown'
	);
	assert.equal(conv.get().commentComposer.outcome, 'unknown');

	// 2. Definite error (400)
	const res2 = await conv.addComment();
	assert.equal(res2.status, 'error');
	assert.equal(
		conv.get().commentComposer.draft,
		'Mensaje importante',
		'preserva borrador en error'
	);
	assert.equal(conv.get().commentComposer.outcome, 'error');

	// 3. Success
	const res3 = await conv.addComment();
	assert.equal(res3.status, 'success');
	assert.equal(conv.get().commentComposer.draft, '', 'limpia borrador solo en éxito confirmado');
	assert.equal(conv.get().commentComposer.outcome, 'success');

	conv.dispose();
});

test('UI-2D-A: stale request protection (cambio de incidencia y tenant no contaminan)', async () => {
	const gates = [];
	const conv = createIncidentConversation({
		listComments: async () => {
			const d = deferred();
			gates.push(d);
			return d.promise;
		}
	});

	// Carga incidencia 1 en tenant A
	conv.setTarget({
		identity: identity(['incidents:view_all'], ORG_A, 1),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	const load1 = conv.loadComments();

	// Cambio a incidencia 2 en tenant B
	conv.setTarget({
		identity: identity(['incidents:view_all'], ORG_B, 2),
		incidentId: INCIDENT_B,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	const load2 = conv.loadComments();

	// Resolver petición de incidencia 1 ahora obsoleta
	gates[0].resolve({
		items: [commentItem('stale_c', 'Comentario de incidencia 1')],
		nextCursor: null
	});
	await load1;

	// La incidencia 2 no debe contener el comentario de incidencia 1
	assert.equal(conv.get().comments.items.length, 0);

	// Resolver petición de incidencia 2
	gates[1].resolve({
		items: [commentItem('current_c', 'Comentario de incidencia 2')],
		nextCursor: null
	});
	await load2;

	assert.equal(conv.get().comments.items.length, 1);
	assert.equal(conv.get().comments.items[0].id, 'current_c');

	conv.dispose();
});

test('UI-2D-B: notas internas solo accesibles para staff con view_internal_notes', async () => {
	let noteFetchCount = 0;
	const conv = createIncidentConversation({
		listInternalNotes: async () => {
			noteFetchCount++;
			return { items: [noteItem()], nextCursor: null };
		}
	});

	// 1. Requester NUNCA carga notas internas
	conv.setTarget({
		identity: identity(['incidents:view_requested']),
		incidentId: INCIDENT_A,
		audience: 'requester',
		capabilities: ['incidents:view_requested']
	});
	await conv.loadInternalNotes();
	assert.equal(noteFetchCount, 0, 'requester nunca solicita endpoint de notas');
	assert.equal(conv.get().internalNotes.status, 'idle');

	// Intento de forzar cambio de tab en requester -> no hace nada
	conv.setActiveTab('internalNotes');
	assert.equal(conv.get().activeTab, 'comments');

	// 2. Staff sin capability view_internal_notes tampoco carga notas
	conv.setTarget({
		identity: identity(['incidents:view_all']),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	await conv.loadInternalNotes();
	assert.equal(noteFetchCount, 0, 'staff sin view_internal_notes no solicita notas');
	conv.setActiveTab('internalNotes');
	assert.equal(conv.get().activeTab, 'comments');

	// 3. Staff con view_internal_notes sí carga notas
	conv.setTarget({
		identity: identity(['incidents:view_all', 'incidents:view_internal_notes']),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all', 'incidents:view_internal_notes']
	});
	conv.setActiveTab('internalNotes');
	assert.equal(conv.get().activeTab, 'internalNotes');
	await conv.loadInternalNotes();
	assert.equal(noteFetchCount, 1);
	assert.equal(conv.get().internalNotes.status, 'ready');
	assert.equal(conv.get().internalNotes.items.length, 1);

	conv.dispose();
});

test('UI-2D-B: borradores de comentarios y notas estrictamente separados', async () => {
	const conv = createIncidentConversation({
		createComment: async (opts) => commentItem('c_new', opts.body),
		createInternalNote: async (opts) => noteItem('n_new', opts.body)
	});

	conv.setTarget({
		identity: identity([
			'incidents:view_all',
			'incidents:view_internal_notes',
			'incidents:add_internal_note',
			'incidents:add_comment'
		]),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: [
			'incidents:view_all',
			'incidents:view_internal_notes',
			'incidents:add_internal_note',
			'incidents:add_comment'
		]
	});

	conv.setCommentDraft('Borrador público');
	conv.setInternalNoteDraft('Borrador confidencial interno');

	assert.equal(conv.get().commentComposer.draft, 'Borrador público');
	assert.equal(conv.get().internalNoteComposer.draft, 'Borrador confidencial interno');

	// Cambiar de tab preserva ambos sin cruzarlos
	conv.setActiveTab('internalNotes');
	assert.equal(conv.get().commentComposer.draft, 'Borrador público');
	assert.equal(conv.get().internalNoteComposer.draft, 'Borrador confidencial interno');

	conv.setActiveTab('comments');
	assert.equal(conv.get().commentComposer.draft, 'Borrador público');
	assert.equal(conv.get().internalNoteComposer.draft, 'Borrador confidencial interno');

	// Enviar nota interna limpia solo el borrador interno
	await conv.addInternalNote();
	assert.equal(conv.get().internalNoteComposer.draft, '');
	assert.equal(
		conv.get().commentComposer.draft,
		'Borrador público',
		'borrador público no afectado'
	);

	conv.dispose();
});

test('UI-2D-B: aislamiento de fallos entre comentarios y notas', async () => {
	const conv = createIncidentConversation({
		listComments: async () => ({ items: [commentItem('c1', 'Comentario OK')], nextCursor: null }),
		listInternalNotes: async () => {
			throw new ApiError(500, 'SERVER_ERROR', 'Error interno al leer notas');
		}
	});

	conv.setTarget({
		identity: identity(['incidents:view_all', 'incidents:view_internal_notes']),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all', 'incidents:view_internal_notes']
	});

	await conv.loadComments();
	await conv.loadInternalNotes();

	// El fallo 500 de notas no rompe la conversación pública
	assert.equal(conv.get().comments.status, 'ready');
	assert.equal(conv.get().comments.items.length, 1);
	assert.equal(conv.get().internalNotes.status, 'error');
	assert.equal(conv.get().internalNotes.error.status, 500);

	conv.dispose();
});

test('UI-2D-B: detección de 401 para re-autenticación limpia', async () => {
	const conv = createIncidentConversation({
		listComments: async () => {
			throw new ApiError(401, 'UNAUTHORIZED', 'Sesión expirada');
		}
	});

	conv.setTarget({
		identity: identity(),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});

	await conv.loadComments();
	const authErr = unauthenticatedConversationError(conv.get());
	assert.ok(authErr);
	assert.equal(authErr.status, 401);

	conv.dispose();
});

test('UI-2D SSR: render de requester y staff (sentinel secret + XSS literal)', async () => {
	const server = await createServer({
		root,
		configFile: false,
		envDir: false,
		logLevel: 'silent',
		resolve: { alias: { $lib: path.resolve(root, 'src/lib') } },
		plugins: [svelte({ configFile: false })],
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom'
	});

	try {
		const { render } = await server.ssrLoadModule('svelte/server');
		const mod = await server.ssrLoadModule('/src/lib/components/incidents/IncidentActivity.svelte');
		const Activity = mod.default;

		const xssBody = '<script>alert("xss")</script>';
		const sentinelBody = `CONFIDENCIAL: ${SENTINEL}`;

		// Fixture para requester
		const requesterIncident = {
			id: INCIDENT_A,
			incidentNumber: 101,
			title: 'Problema de acceso',
			description: 'No puedo acceder',
			status: 'open',
			priority: 'medium',
			audience: 'requester'
		};

		// Fixture para staff
		const staffIncident = {
			...requesterIncident,
			audience: 'staff',
			client: 'Cliente SL',
			clientUserId: USER_A,
			teamId: null,
			assignedToUserId: null,
			slaPolicyId: null
		};

		// Controlador con datos simulados
		const requesterConv = createIncidentConversation({
			listComments: async () => ({
				items: [commentItem('c1', xssBody, 'Ana')],
				nextCursor: null
			}),
			listInternalNotes: async () => ({
				items: [noteItem('n1', sentinelBody, 'Carlos')],
				nextCursor: null
			})
		});
		requesterConv.setTarget({
			identity: identity(['incidents:view_requested']),
			incidentId: INCIDENT_A,
			audience: 'requester',
			capabilities: ['incidents:view_requested', 'incidents:add_comment']
		});
		await requesterConv.loadComments();

		// 1. Render Requester
		const requesterHtml = render(Activity, {
			props: {
				incident: requesterIncident,
				identity: identity(['incidents:view_requested']),
				capabilities: ['incidents:view_requested', 'incidents:add_comment'],
				conversationController: requesterConv
			}
		}).body;

		// Verificaciones críticas de seguridad en Requester:
		assert.ok(requesterHtml.includes('Conversación'), 'requester tiene sección de conversación');
		assert.ok(
			!requesterHtml.includes('Notas internas'),
			'requester NUNCA muestra pestaña o mención de notas internas'
		);
		assert.ok(
			!requesterHtml.includes(SENTINEL),
			'requester NUNCA contiene el sentinel de nota interna'
		);
		// XSS se renderiza seguro (escapado)
		assert.ok(
			!requesterHtml.includes('<script>alert("xss")</script>'),
			'no debe contener etiqueta script viva'
		);
		assert.ok(
			requesterHtml.includes('&lt;script>alert("xss")&lt;/script>'),
			'se escapa como texto'
		);

		// 2. Render Staff con notas
		const staffConv = createIncidentConversation({
			listComments: async () => ({
				items: [commentItem('c1', 'Comentario staff', 'Ana')],
				nextCursor: null
			}),
			listInternalNotes: async () => ({
				items: [noteItem('n1', sentinelBody, 'Carlos')],
				nextCursor: null
			})
		});
		staffConv.setTarget({
			identity: identity(['incidents:view_all', 'incidents:view_internal_notes']),
			incidentId: INCIDENT_A,
			audience: 'staff',
			capabilities: [
				'incidents:view_all',
				'incidents:view_internal_notes',
				'incidents:add_internal_note'
			]
		});
		await staffConv.loadComments();
		staffConv.setActiveTab('internalNotes');
		await staffConv.loadInternalNotes();

		const staffHtml = render(Activity, {
			props: {
				incident: staffIncident,
				identity: identity(['incidents:view_all', 'incidents:view_internal_notes']),
				capabilities: [
					'incidents:view_all',
					'incidents:view_internal_notes',
					'incidents:add_internal_note'
				],
				conversationController: staffConv
			}
		}).body;

		assert.ok(
			staffHtml.includes('Notas internas'),
			'staff autorizado sí tiene pestaña de notas internas'
		);
		assert.ok(staffHtml.includes(SENTINEL), 'staff autorizado ve la nota interna');

		requesterConv.dispose();
		staffConv.dispose();
	} finally {
		await server.close();
	}
});

test('UI-2D: bloqueo pre-send si faltan capabilities (add_comment y add_internal_note)', async () => {
	let commentCalls = 0;
	let noteCalls = 0;
	const conv = createIncidentConversation({
		createComment: async () => {
			commentCalls++;
			return commentItem();
		},
		createInternalNote: async () => {
			noteCalls++;
			return noteItem();
		}
	});

	// Usuario solo con permiso de lectura (sin add_comment ni add_internal_note)
	conv.setTarget({
		identity: identity(['incidents:view_all', 'incidents:view_internal_notes']),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all', 'incidents:view_internal_notes']
	});

	const commentRes = await conv.addComment('Intento sin permiso');
	assert.equal(commentRes.status, 'error');
	assert.equal(commentRes.error?.status, 403);
	assert.equal(commentCalls, 0, 'no debe llamar a la API si falta incidents:add_comment');

	const noteRes = await conv.addInternalNote('Intento sin permiso');
	assert.equal(noteRes.status, 'error');
	assert.equal(noteRes.error?.status, 403);
	assert.equal(noteCalls, 0, 'no debe llamar a la API si falta incidents:add_internal_note');

	conv.dispose();
});

test('UI-2D: aislamiento multi-tenant e IDOR (claves y parámetros de red independientes)', async () => {
	const calls = [];
	const conv = createIncidentConversation({
		listComments: async (opts) => {
			calls.push(opts);
			return { items: [], nextCursor: null };
		}
	});

	// Org A + Incidente A
	conv.setTarget({
		identity: identity(['incidents:view_all'], ORG_A, 1),
		incidentId: INCIDENT_A,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	await conv.loadComments();
	const keyA = conv.get().targetKey;

	// Org B + Incidente B
	conv.setTarget({
		identity: identity(['incidents:view_all'], ORG_B, 1),
		incidentId: INCIDENT_B,
		audience: 'staff',
		capabilities: ['incidents:view_all']
	});
	await conv.loadComments();
	const keyB = conv.get().targetKey;

	assert.notEqual(keyA, keyB, 'las claves de target deben diferir entre tenants e incidentes');
	assert.ok(keyA.includes(ORG_A) && keyA.includes(INCIDENT_A));
	assert.ok(keyB.includes(ORG_B) && keyB.includes(INCIDENT_B));

	assert.equal(calls[0].organizationId, ORG_A);
	assert.equal(calls[0].incidentId, INCIDENT_A);
	assert.equal(calls[1].organizationId, ORG_B);
	assert.equal(calls[1].incidentId, INCIDENT_B);

	conv.dispose();
});
