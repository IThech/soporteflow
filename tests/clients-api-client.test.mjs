import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
	listClients,
	getClient,
	createClient,
	renameClient,
	updateClient,
	setClientActive,
	ClientApiError
} from '../src/lib/api/clients.ts';

const ORG = randomUUID();
const CLIENT_ID = randomUUID();

function client(overrides = {}) {
	return {
		id: randomUUID(),
		name: 'Empresa Test S.L.',
		description: 'Cliente corporativo',
		active: true,
		createdAt: '2026-05-01T10:20:30.123Z',
		updatedAt: '2026-05-02T10:20:30.123Z',
		...overrides
	};
}

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function mockFetch(respond) {
	const calls = [];
	const customFetch = async (url, init) => {
		calls.push({ url, init });
		return typeof respond === 'function' ? respond(url, init) : respond;
	};
	return { customFetch, calls };
}

test('SoporteFlow — Cliente API de Clientes: operaciones, validaciones y errores', async (t) => {
	await t.test('1. Validaciones previas de UUID y argumentos', async () => {
		await assert.rejects(
			listClients({ organizationId: 'not-a-uuid' }),
			/Identificador de organización no válido/
		);
		await assert.rejects(
			createClient({ organizationId: ORG, name: '   ' }),
			/El nombre del cliente no es válido/
		);
		await assert.rejects(
			renameClient({ organizationId: ORG, clientId: 'bad', name: 'Valid' }),
			/Identificador de cliente no válido/
		);
		await assert.rejects(
			updateClient({ organizationId: ORG, clientId: CLIENT_ID, name: '' }),
			/El nombre del cliente no es válido/
		);
		await assert.rejects(
			setClientActive({ organizationId: ORG, clientId: CLIENT_ID, active: 'yes' }),
			/El estado debe ser un booleano/
		);
	});

	await t.test('2. listClients: llamadas HTTP y mapeo correcto', async () => {
		const sample = [client(), client({ name: 'Beta Systems' })];
		const { customFetch, calls } = mockFetch(jsonResponse({ clients: sample }));

		const result = await listClients({ organizationId: ORG, activeOnly: true, customFetch });
		assert.equal(calls.length, 1);
		assert.ok(calls[0].url.includes(`organizationId=${ORG}`));
		assert.ok(calls[0].url.includes('activeOnly=true'));
		assert.equal(result.length, 2);
		assert.equal(result[0].name, sample[0].name);
	});

	await t.test('3. getClient: llamadas HTTP y retorno de item', async () => {
		const sample = client({ id: CLIENT_ID });
		const { customFetch, calls } = mockFetch(jsonResponse({ client: sample }));

		const result = await getClient({ organizationId: ORG, clientId: CLIENT_ID, customFetch });
		assert.equal(calls.length, 1);
		assert.ok(calls[0].url.includes(`/api/clients/${CLIENT_ID}`));
		assert.equal(result.id, CLIENT_ID);
	});

	await t.test('4. createClient: envío de payload y respuesta', async () => {
		const sample = client({ name: 'Nuevo Cliente', description: 'Nota' });
		const { customFetch, calls } = mockFetch(jsonResponse({ client: sample }, 201));

		const result = await createClient({
			organizationId: ORG,
			name: '  Nuevo Cliente  ',
			description: 'Nota',
			customFetch
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].init.method, 'POST');
		const body = JSON.parse(calls[0].init.body);
		assert.equal(body.name, 'Nuevo Cliente');
		assert.equal(body.description, 'Nota');
		assert.equal(result.name, 'Nuevo Cliente');
	});

	await t.test('5. renameClient y setClientActive: PATCH con acción discriminada', async () => {
		const { customFetch, calls } = mockFetch((url, init) => {
			const body = JSON.parse(init.body);
			return jsonResponse({
				client: client({
					id: CLIENT_ID,
					name: body.name || 'Sample',
					active: body.active !== undefined ? body.active : true
				})
			});
		});

		await renameClient({
			organizationId: ORG,
			clientId: CLIENT_ID,
			name: 'Renombrado',
			customFetch
		});
		assert.equal(calls[0].init.method, 'PATCH');
		assert.deepEqual(JSON.parse(calls[0].init.body), { action: 'rename', name: 'Renombrado' });

		await setClientActive({
			organizationId: ORG,
			clientId: CLIENT_ID,
			active: false,
			customFetch
		});
		assert.equal(calls[1].init.method, 'PATCH');
		assert.deepEqual(JSON.parse(calls[1].init.body), { action: 'set_active', active: false });
	});

	await t.test('6. Manejo de errores HTTP (409 conflicto, 404 no encontrado)', async () => {
		const { customFetch: conflictFetch } = mockFetch(
			jsonResponse({ error: { code: 'CLIENT_NAME_DUPLICATE', message: 'Ya existe' } }, 409)
		);
		await assert.rejects(
			createClient({ organizationId: ORG, name: 'Duplicado', customFetch: conflictFetch }),
			(err) => {
				assert.ok(err instanceof ClientApiError);
				assert.equal(err.status, 409);
				assert.equal(err.code, 'CLIENT_NAME_DUPLICATE');
				return true;
			}
		);

		const { customFetch: notFoundFetch } = mockFetch(
			jsonResponse({ error: { code: 'CLIENT_NOT_FOUND', message: 'No existe' } }, 404)
		);
		await assert.rejects(
			getClient({ organizationId: ORG, clientId: CLIENT_ID, customFetch: notFoundFetch }),
			(err) => {
				assert.ok(err instanceof ClientApiError);
				assert.equal(err.status, 404);
				assert.equal(err.code, 'CLIENT_NOT_FOUND');
				return true;
			}
		);
	});
});
