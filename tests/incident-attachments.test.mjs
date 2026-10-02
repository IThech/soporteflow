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
const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh6sAAAAASUVORK5CYII=',
	'base64'
);
const jpg = Buffer.from(
	'/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==',
	'base64'
);
const webp = Buffer.from('UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/vz0AAA=', 'base64');
function makePdf(targetLength) {
	const header = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< >>\n%');
	const footer = Buffer.from('\n%%EOF\n');
	const padLength = targetLength - header.length - footer.length;
	if (padLength < 0) throw new Error('Target length too small for PDF');
	const padding = Buffer.alloc(padLength, 0x20);
	return Buffer.concat([header, padding, footer]);
}
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

	// DEPLOYMENT_ENV=dev allows DEV storage even when NODE_ENV=production
	const prevNodeEnv = process.env.NODE_ENV;
	const prevDeployEnv = process.env.DEPLOYMENT_ENV;
	try {
		process.env.NODE_ENV = 'production';
		process.env.DEPLOYMENT_ENV = 'dev';
		const devUploaded = await route.POST(event('POST'));
		assert.equal(devUploaded.status, 201, 'upload allowed in DEV with NODE_ENV=production');

		// DEPLOYMENT_ENV=production rejects DEV storage
		process.env.DEPLOYMENT_ENV = 'production';
		const prodBlocked = await route.POST(event('POST'));
		assert.equal(prodBlocked.status, 503, 'upload blocked in production deployment');
		const prodBody = await prodBlocked.json();
		assert.equal(prodBody.error.code, 'STORAGE_NOT_CONFIGURED');
	} finally {
		if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = prevNodeEnv;
		if (prevDeployEnv === undefined) delete process.env.DEPLOYMENT_ENV;
		else process.env.DEPLOYMENT_ENV = prevDeployEnv;
	}

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

test('storage selection: NODE_ENV=production + DEPLOYMENT_ENV=dev allows DEV storage; production environment blocks it', async () => {
	const { isDevStorageAllowed } = await import('../src/lib/server/attachments/environment.ts');

	// 1. NODE_ENV=production + entorno SoporteFlow DEV + ATTACHMENT_DEV_ROOT configurado → storage DEV permitido
	assert.equal(
		isDevStorageAllowed({
			NODE_ENV: 'production',
			DEPLOYMENT_ENV: 'dev',
			ATTACHMENT_DEV_ROOT: '/var/lib/soporteflow/attachments'
		}),
		true
	);
	assert.equal(
		isDevStorageAllowed({
			NODE_ENV: 'production',
			DEPLOYMENT_ENV: 'development',
			ATTACHMENT_DEV_ROOT: '/var/lib/soporteflow/attachments'
		}),
		true
	);

	// 2. entorno SoporteFlow production + ATTACHMENT_DEV_ROOT → storage DEV rechazado
	assert.equal(
		isDevStorageAllowed({
			NODE_ENV: 'production',
			DEPLOYMENT_ENV: 'production',
			ATTACHMENT_DEV_ROOT: '/var/lib/soporteflow/attachments'
		}),
		false
	);
	assert.equal(
		isDevStorageAllowed({
			NODE_ENV: 'development',
			DEPLOYMENT_ENV: 'production',
			ATTACHMENT_DEV_ROOT: '/var/lib/soporteflow/attachments'
		}),
		false
	);

	// 3. Fallbacks de seguridad: sin DEPLOYMENT_ENV en producción → rechazado por defecto
	assert.equal(
		isDevStorageAllowed({
			NODE_ENV: 'production',
			DEPLOYMENT_ENV: undefined,
			ATTACHMENT_DEV_ROOT: '/var/lib/soporteflow/attachments'
		}),
		false
	);

	// 4. Desarrollo local / test sin DEPLOYMENT_ENV ni NODE_ENV=production → permitido
	assert.equal(
		isDevStorageAllowed({
			NODE_ENV: 'test',
			DEPLOYMENT_ENV: undefined,
			ATTACHMENT_DEV_ROOT: '/tmp/test'
		}),
		true
	);

	// 5. Sin ATTACHMENT_DEV_ROOT → siempre rechazado
	assert.equal(
		isDevStorageAllowed({
			NODE_ENV: 'production',
			DEPLOYMENT_ENV: 'dev',
			ATTACHMENT_DEV_ROOT: undefined
		}),
		false
	);
	assert.equal(
		isDevStorageAllowed({
			NODE_ENV: 'production',
			DEPLOYMENT_ENV: 'dev',
			ATTACHMENT_DEV_ROOT: '   '
		}),
		false
	);
});

test('audit 2: size limits - 5 MiB boundary accepted, > 5 MiB rejected (413), zero orphans in storage', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'sf-audit2-size-'));
	const prev = process.env.ATTACHMENT_DEV_ROOT;
	process.env.ATTACHMENT_DEV_ROOT = root;
	t.after(async () => {
		if (prev === undefined) delete process.env.ATTACHMENT_DEV_ROOT;
		else process.env.ATTACHMENT_DEV_ROOT = prev;
		await rm(root, { recursive: true, force: true });
	});
	const f = await fixture(t);
	const user = await identity(f);
	const session = await createSession(f, user.id);
	const [org] = await f.db
		.insert(f.schema.organizations)
		.values({ name: 'SizeOrg', slug: randomUUID(), status: 'active' })
		.returning();
	const [member] = await f.db
		.insert(f.schema.memberships)
		.values({ organizationId: org.id, userId: user.id })
		.returning();
	const [inc] = await f.db
		.insert(f.schema.incidents)
		.values({
			organizationId: org.id,
			incidentNumber: 1,
			title: 'Size Test',
			description: 'Desc',
			client: 'Client',
			createdByUserId: user.id,
			clientUserId: user.id
		})
		.returning();
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:view_requested'
	});
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:add_comment'
	});

	const route = await f.server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/attachments/+server.ts'
	);
	function uploadEvent(file) {
		const url = new URL(
			`http://localhost/api/incidents/${inc.id}/attachments?organizationId=${org.id}`
		);
		const body = new FormData();
		body.append('file', file);
		const request = new Request(url, { method: 'POST', headers: session.headers, body });
		return { request, url, params: { id: inc.id } };
	}

	// Unit validation check
	const exact5MbPdf = makePdf(5242880);
	assert.doesNotThrow(() =>
		validateAttachment(
			{ name: 'boundary.pdf', type: 'application/pdf', size: 5242880 },
			exact5MbPdf
		)
	);
	const oversizedPdf = makePdf(5242881);
	assert.throws(
		() =>
			validateAttachment(
				{ name: 'over.pdf', type: 'application/pdf', size: 5242881 },
				oversizedPdf
			),
		(e) => e.status === 413 && e.code === 'PAYLOAD_TOO_LARGE'
	);

	// 1. Boundary: exactly 5 MiB (5242880 bytes) is valid and accepted -> 201
	const boundaryFile = new File([exact5MbPdf], 'boundary.pdf', { type: 'application/pdf' });
	const resBoundary = await route.POST(uploadEvent(boundaryFile));
	assert.equal(resBoundary.status, 201);
	const { item } = await resBoundary.json();
	assert.equal(item.size, 5242880);
	assert.equal((await readdir(root)).length, 1);

	// 2. Oversized: 5 MiB + 1 byte (5242881 bytes) is rejected -> 413
	const oversizedFile = new File([oversizedPdf], 'oversized.pdf', { type: 'application/pdf' });
	const resOversized = await route.POST(uploadEvent(oversizedFile));
	assert.equal(resOversized.status, 413);
	const errBody = await resOversized.json();
	assert.equal(errBody.error.code, 'PAYLOAD_TOO_LARGE');

	// 3. Verify zero orphaned files left in storage (still exactly 1 file from the boundary upload)
	assert.equal((await readdir(root)).length, 1);
});

test('audit 3: quantity limit - 5 allowed, 6th rejected (409 ATTACHMENT_LIMIT), exactly 5 in DB and on disk', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'sf-audit3-qty-'));
	const prev = process.env.ATTACHMENT_DEV_ROOT;
	process.env.ATTACHMENT_DEV_ROOT = root;
	t.after(async () => {
		if (prev === undefined) delete process.env.ATTACHMENT_DEV_ROOT;
		else process.env.ATTACHMENT_DEV_ROOT = prev;
		await rm(root, { recursive: true, force: true });
	});
	const f = await fixture(t);
	const user = await identity(f);
	const session = await createSession(f, user.id);
	const [org] = await f.db
		.insert(f.schema.organizations)
		.values({ name: 'QtyOrg', slug: randomUUID(), status: 'active' })
		.returning();
	const [member] = await f.db
		.insert(f.schema.memberships)
		.values({ organizationId: org.id, userId: user.id })
		.returning();
	const [inc] = await f.db
		.insert(f.schema.incidents)
		.values({
			organizationId: org.id,
			incidentNumber: 1,
			title: 'Qty Test',
			description: 'Desc',
			client: 'Client',
			createdByUserId: user.id,
			clientUserId: user.id
		})
		.returning();
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:view_requested'
	});
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:add_comment'
	});

	const route = await f.server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/attachments/+server.ts'
	);
	function uploadEvent(file) {
		const url = new URL(
			`http://localhost/api/incidents/${inc.id}/attachments?organizationId=${org.id}`
		);
		const body = new FormData();
		body.append('file', file);
		const request = new Request(url, { method: 'POST', headers: session.headers, body });
		return { request, url, params: { id: inc.id } };
	}

	// 1. Upload attachments 1 to 5 -> all succeed with 201
	for (let i = 1; i <= 5; i++) {
		const file = new File([pdf], `doc${i}.pdf`, { type: 'application/pdf' });
		const res = await route.POST(uploadEvent(file));
		assert.equal(res.status, 201, `attachment ${i} must succeed with 201`);
	}

	// 2. Attempt 6th upload -> 409 ATTACHMENT_LIMIT
	const file6 = new File([pdf], 'doc6.pdf', { type: 'application/pdf' });
	const res6 = await route.POST(uploadEvent(file6));
	assert.equal(res6.status, 409);
	const body6 = await res6.json();
	assert.equal(body6.error.code, 'ATTACHMENT_LIMIT');

	// 3. Verify exactly 5 rows in DB
	const dbRows = await f.db
		.select()
		.from(f.schema.incidentAttachments)
		.where(eq(f.schema.incidentAttachments.incidentId, inc.id));
	assert.equal(dbRows.length, 5);

	// 4. Verify exactly 5 files in storage on disk (no 6th orphan)
	const diskFiles = await readdir(root);
	assert.equal(diskFiles.length, 5);
});

test('audit 4: extension, MIME and signature validation - PDF, JPG, JPEG, PNG, WebP accepted; disguises and 0-byte rejected', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'sf-audit4-mime-'));
	const prev = process.env.ATTACHMENT_DEV_ROOT;
	process.env.ATTACHMENT_DEV_ROOT = root;
	t.after(async () => {
		if (prev === undefined) delete process.env.ATTACHMENT_DEV_ROOT;
		else process.env.ATTACHMENT_DEV_ROOT = prev;
		await rm(root, { recursive: true, force: true });
	});
	const f = await fixture(t);
	const user = await identity(f);
	const session = await createSession(f, user.id);
	const [org] = await f.db
		.insert(f.schema.organizations)
		.values({ name: 'MimeOrg', slug: randomUUID(), status: 'active' })
		.returning();
	const [member] = await f.db
		.insert(f.schema.memberships)
		.values({ organizationId: org.id, userId: user.id })
		.returning();
	const [inc] = await f.db
		.insert(f.schema.incidents)
		.values({
			organizationId: org.id,
			incidentNumber: 1,
			title: 'Mime Test',
			description: 'Desc',
			client: 'Client',
			createdByUserId: user.id,
			clientUserId: user.id
		})
		.returning();
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:view_requested'
	});
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:add_comment'
	});

	const route = await f.server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/attachments/+server.ts'
	);
	function uploadEvent(file) {
		const url = new URL(
			`http://localhost/api/incidents/${inc.id}/attachments?organizationId=${org.id}`
		);
		const body = new FormData();
		body.append('file', file);
		const request = new Request(url, { method: 'POST', headers: session.headers, body });
		return { request, url, params: { id: inc.id } };
	}

	// 1. Valid files of all supported formats (PDF, JPG, JPEG, PNG, WebP)
	const validFiles = [
		new File([pdf], 'document.pdf', { type: 'application/pdf' }),
		new File([jpg], 'photo.jpg', { type: 'image/jpeg' }),
		new File([jpg], 'photo.jpeg', { type: 'image/jpeg' }),
		new File([png], 'diagram.png', { type: 'image/png' }),
		new File([webp], 'graphic.webp', { type: 'image/webp' })
	];
	for (const file of validFiles) {
		await f.db
			.delete(f.schema.incidentAttachments)
			.where(eq(f.schema.incidentAttachments.incidentId, inc.id));
		const res = await route.POST(uploadEvent(file));
		assert.equal(res.status, 201, `uploading ${file.name} should return 201`);
	}

	// 2. Disallowed extensions (.exe, .sh, .txt, .html)
	for (const [name, type, bytes] of [
		['malicious.exe', 'application/x-msdownload', Buffer.from('MZ...')],
		['script.sh', 'text/x-shellscript', Buffer.from('#!/bin/sh\necho hi')],
		['notes.txt', 'text/plain', Buffer.from('plain text')],
		['page.html', 'text/html', Buffer.from('<html></html>')]
	]) {
		const res = await route.POST(uploadEvent(new File([bytes], name, { type })));
		assert.equal(res.status, 400, `disallowed extension "${name}" must be rejected`);
		const body = await res.json();
		assert.equal(body.error.code, 'INVALID_FILE');
	}

	// 3. MIME declared allowed, but content is incompatible (application/pdf with PNG bytes)
	const fakePdf = new File([png], 'fake.pdf', { type: 'application/pdf' });
	const resFakePdf = await route.POST(uploadEvent(fakePdf));
	assert.equal(resFakePdf.status, 400);
	assert.equal((await resFakePdf.json()).error.code, 'INVALID_FILE_CONTENT');

	// 4. Extension allowed (JPG), declared MIME image/jpeg, but content is PNG
	const disguisedJpg = new File([png], 'disguised.jpg', { type: 'image/jpeg' });
	const resDisguised = await route.POST(uploadEvent(disguisedJpg));
	assert.equal(resDisguised.status, 400);
	assert.equal((await resDisguised.json()).error.code, 'INVALID_FILE_CONTENT');

	// 5. Arbitrary text content renamed to .jpg with image/jpeg
	const textJpg = new File(
		[Buffer.from('Not an image at all, just plain text string.')],
		'test.jpg',
		{
			type: 'image/jpeg'
		}
	);
	const resTextJpg = await route.POST(uploadEvent(textJpg));
	assert.equal(resTextJpg.status, 400);
	assert.equal((await resTextJpg.json()).error.code, 'INVALID_FILE_CONTENT');

	// 6. Empty 0-byte file
	const emptyFile = new File([Buffer.alloc(0)], 'empty.pdf', { type: 'application/pdf' });
	const resEmpty = await route.POST(uploadEvent(emptyFile));
	assert.equal(resEmpty.status, 400);
	assert.equal((await resEmpty.json()).error.code, 'INVALID_FILE');
});

test('audit 5: filename security - traversal, separators, length, double extensions rejected; unicode/spaces metadata and UUID storage', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'sf-audit5-name-'));
	const prev = process.env.ATTACHMENT_DEV_ROOT;
	process.env.ATTACHMENT_DEV_ROOT = root;
	t.after(async () => {
		if (prev === undefined) delete process.env.ATTACHMENT_DEV_ROOT;
		else process.env.ATTACHMENT_DEV_ROOT = prev;
		await rm(root, { recursive: true, force: true });
	});
	const f = await fixture(t);
	const user = await identity(f);
	const session = await createSession(f, user.id);
	const [org] = await f.db
		.insert(f.schema.organizations)
		.values({ name: 'NameOrg', slug: randomUUID(), status: 'active' })
		.returning();
	const [member] = await f.db
		.insert(f.schema.memberships)
		.values({ organizationId: org.id, userId: user.id })
		.returning();
	const [inc] = await f.db
		.insert(f.schema.incidents)
		.values({
			organizationId: org.id,
			incidentNumber: 1,
			title: 'Name Test',
			description: 'Desc',
			client: 'Client',
			createdByUserId: user.id,
			clientUserId: user.id
		})
		.returning();
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:view_requested'
	});
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:add_comment'
	});

	const route = await f.server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/attachments/+server.ts'
	);
	function uploadEvent(file) {
		const url = new URL(
			`http://localhost/api/incidents/${inc.id}/attachments?organizationId=${org.id}`
		);
		const body = new FormData();
		body.append('file', file);
		const request = new Request(url, { method: 'POST', headers: session.headers, body });
		return { request, url, params: { id: inc.id } };
	}

	// 1. Problematic filenames rejected:
	const maliciousNames = [
		'../../archivo.jpg',
		'..\\..\\archivo.jpg',
		'sub/archivo.jpg',
		'sub\\archivo.jpg',
		'archivo.jpg\0',
		'archivo.jpg\r\n',
		'a'.repeat(177) + '.jpg', // 181 chars > 180
		'archivo.jpg.exe'
	];
	for (const badName of maliciousNames) {
		const file = new File([jpg], badName, { type: 'image/jpeg' });
		const res = await route.POST(uploadEvent(file));
		assert.equal(res.status, 400, `malicious filename "${badName}" must return 400`);
		const body = await res.json();
		assert.equal(body.error.code, 'INVALID_FILE');
	}

	// 2. Valid filenames with spaces and Spanish Unicode characters:
	const safeUnicodeName = 'captura de pantalla (sede ñandú).png';
	const safeSpaceName = 'death standing.JPG';

	const resUnicode = await route.POST(
		uploadEvent(new File([png], safeUnicodeName, { type: 'image/png' }))
	);
	assert.equal(resUnicode.status, 201);
	const { item: itemUnicode } = await resUnicode.json();
	assert.equal(itemUnicode.originalName, safeUnicodeName);

	const resSpace = await route.POST(
		uploadEvent(new File([jpg], safeSpaceName, { type: 'image/jpeg' }))
	);
	assert.equal(resSpace.status, 201);
	const { item: itemSpace } = await resSpace.json();
	assert.equal(itemSpace.originalName, safeSpaceName);

	// 3. Verify that physical files on disk use internal UUIDs, NEVER the original user-supplied name
	const filesOnDisk = await readdir(root);
	assert.equal(filesOnDisk.length, 2);
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
	for (const filename of filesOnDisk) {
		assert.match(filename, uuidRegex, `disk filename "${filename}" must be a UUID`);
		assert.equal(filename.includes('captura'), false);
		assert.equal(filename.includes('death'), false);
	}
});

test('audit 6: storage security - private root, DTO privacy, download headers, no public access', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'sf-audit6-sec-'));
	const prev = process.env.ATTACHMENT_DEV_ROOT;
	process.env.ATTACHMENT_DEV_ROOT = root;
	t.after(async () => {
		if (prev === undefined) delete process.env.ATTACHMENT_DEV_ROOT;
		else process.env.ATTACHMENT_DEV_ROOT = prev;
		await rm(root, { recursive: true, force: true });
	});
	const f = await fixture(t);
	const user = await identity(f);
	const session = await createSession(f, user.id);
	const [org] = await f.db
		.insert(f.schema.organizations)
		.values({ name: 'SecOrg', slug: randomUUID(), status: 'active' })
		.returning();
	const [member] = await f.db
		.insert(f.schema.memberships)
		.values({ organizationId: org.id, userId: user.id })
		.returning();
	const [inc] = await f.db
		.insert(f.schema.incidents)
		.values({
			organizationId: org.id,
			incidentNumber: 1,
			title: 'Sec Test',
			description: 'Desc',
			client: 'Client',
			createdByUserId: user.id,
			clientUserId: user.id
		})
		.returning();
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:view_requested'
	});
	await grantPermission(f, {
		organizationId: org.id,
		membershipId: member.id,
		permissionId: 'incidents:add_comment'
	});

	const route = await f.server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/attachments/+server.ts'
	);
	const download = await f.server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/attachments/[attachmentId]/download/+server.ts'
	);

	// 1. Storage cannot be inside repository or relative
	assert.throws(() => localAttachmentStorage(process.cwd()));
	assert.throws(() => localAttachmentStorage('./static'));

	// 2. Upload file and check DTO
	const url = new URL(
		`http://localhost/api/incidents/${inc.id}/attachments?organizationId=${org.id}`
	);
	const form = new FormData();
	form.append('file', new File([pdf], 'report.pdf', { type: 'application/pdf' }));
	const postRes = await route.POST({
		request: new Request(url, { method: 'POST', headers: session.headers, body: form }),
		url,
		params: { id: inc.id }
	});
	assert.equal(postRes.status, 201);
	const { item } = await postRes.json();

	// Verify DTO fields: only safe public fields exposed, never storageKey or actorId
	assert.equal(typeof item.id, 'string');
	assert.equal(item.originalName, 'report.pdf');
	assert.equal(item.mimeType, 'application/pdf');
	assert.equal(item.size, pdf.length);
	assert.equal(typeof item.createdAt, 'string');
	assert.equal('storageKey' in item, false);
	assert.equal('actorId' in item, false);

	// Verify list DTO
	const listRes = await route.GET({
		request: new Request(url, { method: 'GET', headers: session.headers }),
		url,
		params: { id: inc.id }
	});
	assert.equal(listRes.status, 200);
	const { items } = await listRes.json();
	assert.equal(items.length, 1);
	assert.equal('storageKey' in items[0], false);
	assert.equal('actorId' in items[0], false);

	// 3. Download requires authentication
	const dlUrl = new URL(
		`http://localhost/api/incidents/${inc.id}/attachments/${item.id}/download?organizationId=${org.id}`
	);
	const unauthRes = await download.GET({
		request: new Request(dlUrl, { method: 'GET' }),
		url: dlUrl,
		params: { id: inc.id, attachmentId: item.id }
	});
	assert.equal(unauthRes.status, 401);

	// 4. Download with non-existent attachmentId -> 404
	const notFoundRes = await download.GET({
		request: new Request(dlUrl, { method: 'GET', headers: session.headers }),
		url: dlUrl,
		params: { id: inc.id, attachmentId: randomUUID() }
	});
	assert.equal(notFoundRes.status, 404);

	// 5. Download with invalid non-UUID attachmentId -> 400
	const badIdRes = await download.GET({
		request: new Request(dlUrl, { method: 'GET', headers: session.headers }),
		url: dlUrl,
		params: { id: inc.id, attachmentId: 'not-a-uuid' }
	});
	assert.equal(badIdRes.status, 400);

	// 6. Authenticated download headers
	const dlRes = await download.GET({
		request: new Request(dlUrl, { method: 'GET', headers: session.headers }),
		url: dlUrl,
		params: { id: inc.id, attachmentId: item.id }
	});
	assert.equal(dlRes.status, 200);
	assert.equal(dlRes.headers.get('x-content-type-options'), 'nosniff');
	assert.equal(dlRes.headers.get('cache-control'), 'private, no-store');
	assert.match(dlRes.headers.get('content-disposition'), /^attachment;\s*filename="attachment"/);
	assert.deepEqual(Buffer.from(await dlRes.arrayBuffer()), pdf);
});

test('audit 7 & 8: multi-tenant isolation and IDOR/BOLA protection (Org A vs Org B, tampering and scope)', async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'sf-audit78-tenant-'));
	const prev = process.env.ATTACHMENT_DEV_ROOT;
	process.env.ATTACHMENT_DEV_ROOT = root;
	t.after(async () => {
		if (prev === undefined) delete process.env.ATTACHMENT_DEV_ROOT;
		else process.env.ATTACHMENT_DEV_ROOT = prev;
		await rm(root, { recursive: true, force: true });
	});
	const f = await fixture(t);
	const route = await f.server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/attachments/+server.ts'
	);
	const download = await f.server.ssrLoadModule(
		'/src/routes/api/incidents/[id]/attachments/[attachmentId]/download/+server.ts'
	);

	// Create Tenant A: Org A, User A, Inc A
	const userA = await identity(f);
	const sessionA = await createSession(f, userA.id);
	const [orgA] = await f.db
		.insert(f.schema.organizations)
		.values({ name: 'Tenant A', slug: randomUUID(), status: 'active' })
		.returning();
	const [memberA] = await f.db
		.insert(f.schema.memberships)
		.values({ organizationId: orgA.id, userId: userA.id })
		.returning();
	const [incA] = await f.db
		.insert(f.schema.incidents)
		.values({
			organizationId: orgA.id,
			incidentNumber: 1,
			title: 'Inc A',
			description: 'Desc A',
			client: 'Client A',
			createdByUserId: userA.id,
			clientUserId: userA.id
		})
		.returning();
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memberA.id,
		permissionId: 'incidents:view_requested'
	});
	await grantPermission(f, {
		organizationId: orgA.id,
		membershipId: memberA.id,
		permissionId: 'incidents:add_comment'
	});

	// Create Tenant B: Org B, User B, Inc B
	const userB = await identity(f);
	const sessionB = await createSession(f, userB.id);
	const [orgB] = await f.db
		.insert(f.schema.organizations)
		.values({ name: 'Tenant B', slug: randomUUID(), status: 'active' })
		.returning();
	const [memberB] = await f.db
		.insert(f.schema.memberships)
		.values({ organizationId: orgB.id, userId: userB.id })
		.returning();
	const [incB] = await f.db
		.insert(f.schema.incidents)
		.values({
			organizationId: orgB.id,
			incidentNumber: 1,
			title: 'Inc B',
			description: 'Desc B',
			client: 'Client B',
			createdByUserId: userB.id,
			clientUserId: userB.id
		})
		.returning();
	await grantPermission(f, {
		organizationId: orgB.id,
		membershipId: memberB.id,
		permissionId: 'incidents:view_requested'
	});
	await grantPermission(f, {
		organizationId: orgB.id,
		membershipId: memberB.id,
		permissionId: 'incidents:add_comment'
	});

	// Helper to send HTTP requests
	function req(method, session, orgId, incId, attId = undefined, file = null) {
		const base = attId
			? `http://localhost/api/incidents/${incId}/attachments/${attId}/download?organizationId=${orgId}`
			: `http://localhost/api/incidents/${incId}/attachments?organizationId=${orgId}`;
		const url = new URL(base);
		const form = file ? new FormData() : undefined;
		if (file) form.append('file', file);
		const request = new Request(url, {
			method,
			headers: session ? session.headers : {},
			...(method === 'POST' ? { body: form } : {})
		});
		return { request, url, params: { id: incId, attachmentId: attId } };
	}

	// 1. Upload Attachment A to Inc A (by User A)
	const upA = await route.POST(
		req(
			'POST',
			sessionA,
			orgA.id,
			incA.id,
			undefined,
			new File([pdf], 'docA.pdf', { type: 'application/pdf' })
		)
	);
	assert.equal(upA.status, 201);
	const { item: attA } = await upA.json();

	// 2. Upload Attachment B to Inc B (by User B)
	const upB = await route.POST(
		req(
			'POST',
			sessionB,
			orgB.id,
			incB.id,
			undefined,
			new File([png], 'imageB.png', { type: 'image/png' })
		)
	);
	assert.equal(upB.status, 201);
	const { item: attB } = await upB.json();

	// 3. User A lists Inc A -> sees Att A
	const listA = await route.GET(req('GET', sessionA, orgA.id, incA.id));
	assert.equal(listA.status, 200);
	const itemsA = (await listA.json()).items;
	assert.equal(itemsA.length, 1);
	assert.equal(itemsA[0].id, attA.id);

	// 4. User B lists Inc B -> sees Att B
	const listB = await route.GET(req('GET', sessionB, orgB.id, incB.id));
	assert.equal(listB.status, 200);
	const itemsB = (await listB.json()).items;
	assert.equal(itemsB.length, 1);
	assert.equal(itemsB[0].id, attB.id);

	// 5. Cross-tenant listing attempts by User A:
	// a) Querying Inc B using Org A -> 404 (incident B does not exist in Org A)
	assert.equal((await route.GET(req('GET', sessionA, orgA.id, incB.id))).status, 404);
	// b) Querying Inc B using Org B -> 403 (User A is not a member of Org B)
	assert.equal((await route.GET(req('GET', sessionA, orgB.id, incB.id))).status, 403);
	// c) Querying Inc A using Org B -> 403 (User A is not a member of Org B)
	assert.equal((await route.GET(req('GET', sessionA, orgB.id, incA.id))).status, 403);

	// 6. Cross-tenant download attempts by User A:
	// a) Att B under Inc B with Org A -> 404
	assert.equal((await download.GET(req('GET', sessionA, orgA.id, incB.id, attB.id))).status, 404);
	// b) Att B under Inc B with Org B -> 403 (User A not in Org B)
	assert.equal((await download.GET(req('GET', sessionA, orgB.id, incB.id, attB.id))).status, 403);
	// c) Att B under Inc A with Org A (IDOR tampering) -> 404 (attB not in incA)
	assert.equal((await download.GET(req('GET', sessionA, orgA.id, incA.id, attB.id))).status, 404);

	// 7. Cross-tenant download attempts by User B:
	// a) Att A under Inc A with Org B -> 404
	assert.equal((await download.GET(req('GET', sessionB, orgB.id, incA.id, attA.id))).status, 404);
	// b) Att A under Inc A with Org A -> 403 (User B not in Org A)
	assert.equal((await download.GET(req('GET', sessionB, orgA.id, incA.id, attA.id))).status, 403);
	// c) Att A under Inc B with Org B (IDOR tampering) -> 404 (attA not in incB)
	assert.equal((await download.GET(req('GET', sessionB, orgB.id, incB.id, attA.id))).status, 404);

	// 8. Cross-tenant upload attempts by User A:
	// a) Uploading to Inc B with Org A -> 404
	assert.equal(
		(
			await route.POST(
				req(
					'POST',
					sessionA,
					orgA.id,
					incB.id,
					undefined,
					new File([pdf], 'hack.pdf', { type: 'application/pdf' })
				)
			)
		).status,
		404
	);
	// b) Uploading to Inc B with Org B -> 403
	assert.equal(
		(
			await route.POST(
				req(
					'POST',
					sessionA,
					orgB.id,
					incB.id,
					undefined,
					new File([pdf], 'hack.pdf', { type: 'application/pdf' })
				)
			)
		).status,
		403
	);

	// 9. Input tampering: multiple organizationId or invalid UUIDs
	const dupOrgUrl = new URL(
		`http://localhost/api/incidents/${incA.id}/attachments?organizationId=${orgA.id}&organizationId=${orgB.id}`
	);
	assert.equal(
		(
			await route.GET({
				request: new Request(dupOrgUrl, { method: 'GET', headers: sessionA.headers }),
				url: dupOrgUrl,
				params: { id: incA.id }
			})
		).status,
		400
	);

	const extraParamUrl = new URL(
		`http://localhost/api/incidents/${incA.id}/attachments?organizationId=${orgA.id}&extra=1`
	);
	assert.equal(
		(
			await route.GET({
				request: new Request(extraParamUrl, { method: 'GET', headers: sessionA.headers }),
				url: extraParamUrl,
				params: { id: incA.id }
			})
		).status,
		400
	);

	const badOrgUrl = new URL(
		`http://localhost/api/incidents/${incA.id}/attachments?organizationId=not-a-uuid`
	);
	assert.equal(
		(
			await route.GET({
				request: new Request(badOrgUrl, { method: 'GET', headers: sessionA.headers }),
				url: badOrgUrl,
				params: { id: incA.id }
			})
		).status,
		400
	);
});
