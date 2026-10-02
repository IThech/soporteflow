import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { fixture, identity, createSession, grantPermission } from './helpers/auth-fixture.mjs';
import { validateAttachment } from '../src/lib/server/attachments/validation.ts';
import { localAttachmentStorage } from '../src/lib/server/attachments/storage.ts';
import { createAttachmentController } from '../src/lib/app/incident-attachments.ts';
import { ApiError } from '../src/lib/api/errors.ts';
import { attachmentUrl, listIncidentAttachments } from '../src/lib/api/incident-attachments.ts';
import { validateApiRequest } from '../src/lib/server/security/web.ts';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
// Minimal complete PDF: catalog, page tree, blank page and a real cross-reference table.
let document = '%PDF-1.4\n';
const offsets = [];
for (const [index, body] of [
	'<< /Type /Catalog /Pages 2 0 R >>',
	'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
	'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>'
].entries()) {
	offsets.push(Buffer.byteLength(document));
	document += `${index + 1} 0 obj\n${body}\nendobj\n`;
}
const xref = Buffer.byteLength(document);
document +=
	'xref\n0 4\n0000000000 65535 f \n' +
	offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
	`trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const pdf = Buffer.from(document);
const metadata = { name: 'document.pdf', type: 'application/pdf', size: pdf.length };
const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((r, j) => {
		resolve = r;
		reject = j;
	});
	return { promise, resolve, reject };
};
const tenant = (org = randomUUID(), generation = 1) => ({
	userId: randomUUID(),
	organizationId: org,
	generation,
	capabilities: ['incidents:add_comment']
});

test('validation: PDF framing, extension/MIME mismatch, names, oversized and disguised content', () => {
	validateAttachment(metadata, pdf);
	for (const patch of [
		{ name: '../x.pdf' },
		{ name: 'x\\y.pdf' },
		{ name: 'x.exe' },
		{ name: 'x.pdf\r\n' },
		{ type: 'image/png' },
		{ size: 5242881 }
	])
		assert.throws(() => validateAttachment({ ...metadata, ...patch }, pdf));
	assert.throws(() => validateAttachment({ ...metadata, size: 3 }, Buffer.from('bad')));
	assert.throws(() => validateAttachment(metadata, Buffer.alloc(pdf.length, 65)));
});
test('validation: actual PNG fixture and corrupt framing', () => {
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh6sAAAAASUVORK5CYII=',
		'base64'
	);
	validateAttachment({ name: 'x.png', type: 'image/png', size: png.length }, png);
	assert.throws(() =>
		validateAttachment(
			{ name: 'x.png', type: 'image/png', size: png.length - 1 },
			png.subarray(0, -1)
		)
	);
});
test('validation: JPEG/JPG and WebP framing', () => {
	const invalidJpeg = Buffer.from([255, 216, ...Array(18).fill(255), 217]);
	assert.throws(
		() =>
			validateAttachment(
				{ name: 'bad.jpg', type: 'image/jpeg', size: invalidJpeg.length },
				invalidJpeg
			),
		(e) => e.status === 400
	);
	// Real 1x1 JPEG, generated once; no image codec dependency in the test suite.
	const jpg = Buffer.from(
		'/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==',
		'base64'
	);
	for (const extension of ['jpg', 'jpeg'])
		validateAttachment({ name: 'x.' + extension, type: 'image/jpeg', size: jpg.length }, jpg);
	const webp = Buffer.from(
		'UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=',
		'base64'
	);
	validateAttachment({ name: 'x.webp', type: 'image/webp', size: webp.length }, webp);
	webp[23] = 0;
	assert.throws(() =>
		validateAttachment({ name: 'x.webp', type: 'image/webp', size: webp.length }, webp)
	);
});
test('private storage: exclusive keys, traversal rejected, bytes preserved, safe cleanup', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'sf-attachments-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const storage = localAttachmentStorage(root);
	const key = randomUUID();
	await storage.put(key, pdf);
	assert.deepEqual(Buffer.from(await storage.read(key)), pdf);
	await assert.rejects(storage.put(key, pdf));
	await assert.rejects(storage.read('../x'));
	assert.throws(() => localAttachmentStorage(process.cwd()));
	await storage.removeFailedUpload(key);
	assert.deepEqual(await readdir(root), []);
});
test('multipart exception: exact route only, Origin mandatory, JSON limits unchanged', async () => {
	const make = (route, origin = 'https://support.example.test', size = 100) => {
		const form = new FormData();
		form.append('file', new File([Buffer.alloc(size)], 'x.pdf', { type: 'application/pdf' }));
		const request = new Request('https://support.example.test/api/incidents/x/attachments', {
			method: 'POST',
			headers: { origin },
			body: form
		});
		return { request, url: new URL(request.url), route: { id: route } };
	};
	const policy = { origin: 'https://support.example.test', development: false };
	assert.equal(await validateApiRequest(make('/api/incidents/[id]/attachments'), policy), null);
	assert.equal(
		(await validateApiRequest(make('/api/incidents/[id]/comments'), policy)).status,
		415
	);
	assert.equal(
		(await validateApiRequest(make('/api/incidents/[id]/attachments', 'https://evil.test'), policy))
			.status,
		403
	);
	const oversized = make('/api/incidents/[id]/attachments');
	oversized.request.headers.set('content-length', '5300000');
	assert.equal((await validateApiRequest(oversized, policy)).status, 413);
});
test('API client: encoded URL, explicit GET, allowlisted DTO, malformed response rejected', async (t) => {
	const original = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = original;
	});
	assert.match(attachmentUrl('a/b', 'x/y'), /x%2Fy.*a%2Fb/);
	globalThis.fetch = async (url, options) => {
		assert.equal(options.method, 'GET');
		return Response.json({ items: [] });
	};
	assert.deepEqual(await listIncidentAttachments('org', 'incident'), []);
	globalThis.fetch = async () => Response.json({ items: [{}] });
	await assert.rejects(
		listIncidentAttachments('org', 'incident'),
		(e) => e.code === 'INVALID_PAYLOAD'
	);
});
test('controller: tenant/incident changes discard late data and stale 401', async () => {
	const a = deferred();
	const b = deferred();
	let calls = 0;
	let expired = 0;
	const c = createAttachmentController(
		{
			list: () => (++calls === 1 ? a.promise : b.promise),
			upload: async () => {},
			download: async () => new Blob()
		},
		() => expired++
	);
	let state;
	c.subscribe((s) => (state = s));
	c.setTarget(tenant(), randomUUID());
	c.setTarget(tenant(), randomUUID());
	b.resolve([]);
	await b.promise;
	await Promise.resolve();
	a.reject(new ApiError(401, 'UNAUTHORIZED', 'expired'));
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(expired, 0);
	assert.deepEqual(state.items, []);
	c.dispose();
});
test('controller: A-B-A never revives old upload; current 401 expires only once', async () => {
	const write = deferred();
	let expired = 0;
	const c = createAttachmentController(
		{
			list: async () => [],
			upload: () => write.promise,
			download: async () => {
				throw new ApiError(401, 'UNAUTHORIZED', 'expired');
			}
		},
		() => expired++
	);
	const a = tenant();
	const id = randomUUID();
	c.setTarget(a, id);
	const operation = c.upload(new File([pdf], 'x.pdf'));
	c.setTarget(tenant(), randomUUID());
	c.setTarget(a, id);
	write.resolve({});
	assert.equal(await operation, false);
	await c.download(randomUUID());
	await c.download(randomUUID());
	assert.equal(expired, 1);
	c.dispose();
});
test('controller: older list cannot overwrite reconciliation; failed reread preserves unknown outcome', async () => {
	const old = deferred();
	let reads = 0;
	const item = {
		id: randomUUID(),
		originalName: 'x.pdf',
		mimeType: 'application/pdf',
		size: pdf.length,
		createdAt: new Date().toISOString()
	};
	const c = createAttachmentController({
		list: () => (++reads === 1 ? old.promise : Promise.resolve([item])),
		upload: async () => {},
		download: async () => new Blob()
	});
	let state;
	c.subscribe((s) => (state = s));
	c.setTarget(tenant(), randomUUID());
	assert.equal(await c.upload(new File([pdf], 'x.pdf')), true);
	old.resolve([]);
	await Promise.resolve();
	assert.deepEqual(state.items, [item]);
	c.dispose();
	let first = true;
	const unknown = createAttachmentController({
		list: async () => {
			if (first) {
				first = false;
				return [];
			}
			throw new ApiError(503, 'UNAVAILABLE', 'Unavailable');
		},
		upload: async () => {
			throw new ApiError(503, 'UPLOAD_OUTCOME_UNKNOWN', 'Unknown');
		},
		download: async () => new Blob()
	});
	unknown.subscribe((s) => (state = s));
	unknown.setTarget(tenant(), randomUUID());
	await Promise.resolve();
	await unknown.upload(new File([pdf], 'x.pdf'));
	await unknown.load();
	assert.equal(state.unknown, true);
	assert.equal(await unknown.upload(new File([pdf], 'x.pdf')), false);
	unknown.dispose();
});
test('controller: busy lasts through reconciliation; unknown blocks resubmit; 403 preserves session', async () => {
	const reload = deferred();
	let lists = 0,
		sends = 0,
		expired = 0;
	const c = createAttachmentController(
		{
			list: () => (++lists === 1 ? Promise.resolve([]) : reload.promise),
			upload: async () => {
				sends++;
			},
			download: async () => {
				throw new ApiError(403, 'FORBIDDEN', 'Denied');
			}
		},
		() => expired++
	);
	let state;
	c.subscribe((s) => (state = s));
	c.setTarget(tenant(), randomUUID());
	await Promise.resolve();
	const first = c.upload(new File([pdf], 'x.pdf'));
	await Promise.resolve();
	assert.equal(state.busy, true);
	assert.equal(await c.upload(new File([pdf], 'x.pdf')), false);
	assert.equal(sends, 1);
	reload.resolve([]);
	assert.equal(await first, true);
	await c.download(randomUUID());
	assert.equal(expired, 0);
	c.dispose();
	const uncertain = createAttachmentController({
		list: async () => [],
		upload: async () => {
			throw new ApiError(0, 'NETWORK_ERROR', 'network');
		},
		download: async () => new Blob()
	});
	uncertain.setTarget(tenant(), randomUUID());
	await uncertain.upload(new File([pdf], 'x.pdf'));
	assert.equal(await uncertain.upload(new File([pdf], 'x.pdf')), false);
	uncertain.dispose();
});
test('PGlite: full migrations, attachment tenant FKs, scope, maximum five, rollback and private DTO', async (t) => {
	const f = await fixture(t);
	const s = f.schema;
	const user = await identity(f);
	const [org] = await f.db
		.insert(s.organizations)
		.values({ name: 'A', slug: randomUUID(), status: 'active' })
		.returning();
	await f.db.insert(s.memberships).values({ organizationId: org.id, userId: user.id });
	const [inc] = await f.db
		.insert(s.incidents)
		.values({
			organizationId: org.id,
			incidentNumber: 1,
			title: 'Synthetic',
			description: 'Test',
			client: 'Synthetic',
			createdByUserId: user.id,
			clientUserId: user.id
		})
		.returning();
	const service = await f.server.ssrLoadModule('/src/lib/server/services/incident-attachments.ts');
	const c = { organizationId: org.id, incidentId: inc.id, access: { clientUserId: user.id } };
	const storage = {
		put: async () => {},
		read: async () => pdf,
		removeFailedUpload: async () => {}
	};
	const row = () => ({
		organizationId: org.id,
		incidentId: inc.id,
		actorId: user.id,
		originalName: 'x.pdf',
		storageKey: randomUUID(),
		mimeType: 'application/pdf',
		size: pdf.length
	});
	for (let i = 0; i < 5; i++)
		await f.db.transaction((tx) => service.insertAttachment(tx, c, row(), pdf, storage));
	await assert.rejects(
		f.db.transaction((tx) => service.insertAttachment(tx, c, row(), pdf, storage)),
		(e) => e.code === 'ATTACHMENT_LIMIT'
	);
	const items = await f.db.transaction((tx) => service.listAttachments(tx, c));
	assert.equal(items.length, 5);
	assert.equal('storageKey' in items[0], false);
	assert.equal('actorId' in items[0], false);
	await assert.rejects(
		f.db.transaction((tx) => service.listAttachments(tx, { ...c, organizationId: randomUUID() })),
		(e) => e.status === 404
	);
	await assert.rejects(
		f.db.transaction((tx) =>
			service.listAttachments(tx, { ...c, access: { assignedToUserId: randomUUID() } })
		),
		(e) => e.status === 404
	);
	await assert.rejects(
		f.db.transaction((tx) => service.downloadAttachment(tx, c, randomUUID(), storage)),
		(e) => e.status === 404
	);
	assert.deepEqual(
		Buffer.from(
			(await f.db.transaction((tx) => service.downloadAttachment(tx, c, items[0].id, storage)))
				.bytes
		),
		pdf
	);
	await assert.rejects(
		f.db.insert(s.incidentAttachments).values({ ...row(), organizationId: randomUUID() })
	);
	await f.db.delete(s.incidentAttachments).where(eq(s.incidentAttachments.incidentId, inc.id));
	await assert.rejects(
		f.db.transaction(async (tx) => {
			await service.insertAttachment(tx, c, row(), pdf, storage);
			throw new Error('rollback');
		})
	);
	assert.equal((await f.db.select().from(s.incidentAttachments)).length, 0);
	await assert.rejects(
		f.db.transaction((tx) =>
			service.insertAttachment(tx, c, row(), pdf, {
				...storage,
				put: async () => {
					throw new Error('disk failure');
				}
			})
		)
	);
	assert.equal((await f.db.select().from(s.incidentAttachments)).length, 0);
});
test('HTTP: authenticated upload/list/download, no capability, foreign tenant/id, expired session and closed incident', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'sf-attachments-http-'));
	const previous = process.env.ATTACHMENT_DEV_ROOT;
	process.env.ATTACHMENT_DEV_ROOT = root;
	t.after(async () => {
		if (previous === undefined) delete process.env.ATTACHMENT_DEV_ROOT;
		else process.env.ATTACHMENT_DEV_ROOT = previous;
		await rm(root, { recursive: true, force: true });
	});
	const f = await fixture(t);
	const s = f.schema;
	const user = await identity(f);
	const session = await createSession(f, user.id);
	const [org] = await f.db
		.insert(s.organizations)
		.values({ name: 'HTTP', slug: randomUUID(), status: 'active' })
		.returning();
	const [member] = await f.db
		.insert(s.memberships)
		.values({ organizationId: org.id, userId: user.id })
		.returning();
	const [inc] = await f.db
		.insert(s.incidents)
		.values({
			organizationId: org.id,
			incidentNumber: 1,
			title: 'HTTP',
			description: 'Synthetic',
			client: 'Synthetic',
			createdByUserId: user.id,
			clientUserId: user.id
		})
		.returning();
	const route = await f.server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/attachments/+server.ts'
	);
	const download = await f.server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/attachments/[attachmentId]/download/+server.ts'
	);
	function event(
		method = 'GET',
		orgId = org.id,
		id = inc.id,
		attachmentId = undefined,
		authenticated = true
	) {
		const url = new URL(`http://localhost/api/incidents/${id}/attachments?organizationId=${orgId}`);
		const body = new FormData();
		body.append('file', new File([pdf], 'safe.pdf', { type: 'application/pdf' }));
		const request = new Request(url, {
			method,
			headers: authenticated ? session.headers : {},
			...(method === 'POST' ? { body } : {})
		});
		return { request, url, params: { id, attachmentId } };
	}
	assert.equal((await route.GET(event('GET', org.id, inc.id, undefined, false))).status, 401);
	assert.equal((await route.GET(event())).status, 403);
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:view_requested'
	});
	assert.equal((await route.POST(event('POST'))).status, 403);
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:add_comment'
	});
	const uploaded = await route.POST(event('POST'));
	assert.equal(uploaded.status, 201);
	const { item } = await uploaded.json();
	assert.equal('storageKey' in item, false);
	assert.equal((await route.GET(event())).status, 200);
	const file = await download.GET(event('GET', org.id, inc.id, item.id));
	assert.equal(file.status, 200);
	assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
	assert.match(file.headers.get('content-disposition'), /^attachment;/);
	assert.deepEqual(Buffer.from(await file.arrayBuffer()), pdf);
	assert.equal((await download.GET(event('GET', org.id, inc.id, randomUUID()))).status, 404);
	assert.equal((await route.GET(event('GET', org.id, randomUUID()))).status, 404);
	assert.equal((await download.GET(event('GET', randomUUID(), inc.id, item.id))).status, 403);
	await f.db.update(s.incidents).set({ status: 'closed' }).where(eq(s.incidents.id, inc.id));
	assert.equal((await route.POST(event('POST'))).status, 409);
	await f.db.delete(s.authSessions).where(eq(s.authSessions.id, session.session.id));
	assert.equal((await download.GET(event('GET', org.id, inc.id, item.id))).status, 401);
});
test('real attachment UI: read-only without capability, selector with capability, no internal-note channel', async (t) => {
	const server = await createServer({
		configFile: false,
		envDir: false,
		server: { middlewareMode: true, hmr: false, watch: null },
		appType: 'custom',
		plugins: [svelte()],
		resolve: { alias: { $lib: path.resolve('src/lib') } }
	});
	t.after(() => server.close());
	const { render } = await server.ssrLoadModule('svelte/server');
	const { default: Component } = await server.ssrLoadModule(
		'/src/lib/components/incidents/IncidentAttachments.svelte'
	);
	const html = render(Component, {
		props: { identity: null, incidentId: randomUUID(), capabilities: [], onSessionExpiry: () => {} }
	}).body;
	assert.match(html, /Adjuntos/);
	assert.doesNotMatch(html, /type="file"|Notas internas/);
	const editable = render(Component, {
		props: {
			identity: null,
			incidentId: randomUUID(),
			capabilities: ['incidents:add_comment'],
			onSessionExpiry: () => {}
		}
	}).body;
	assert.match(editable, /type="file"/);
	assert.match(editable, /5 MB/);
	assert.match(editable, /Subir adjunto/);
});
