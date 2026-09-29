import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ApiError } from '../src/lib/api/errors.ts';
import {
	buildAssignmentPatch,
	buildPriorityPatch,
	buildStatusPatch,
	incidentActions,
	normalizeChangeReason,
	STATUS_TRANSITIONS
} from '../src/lib/app/incident-actions.ts';
import { createMutationChannel, isUncertainMutationFailure } from '../src/lib/app/mutation.ts';
import { presentApiError, presentMutationFailure } from '../src/lib/app/error-presentation.ts';

/** UI-2A — action availability from real capabilities (never roles) and request builders. */
const staff = (status = 'open') => ({ audience: 'staff', status });
const requester = (status = 'open') => ({ audience: 'requester', status });
const ALL = [
	'incidents:view_all',
	'incidents:edit',
	'incidents:assign',
	'incidents:add_comment',
	'incidents:view_internal_notes',
	'incidents:add_internal_note',
	'sla:assign'
];

test('D. requester no obtiene acciones staff aunque tenga capabilities', () => {
	const actions = incidentActions(requester(), ALL);
	for (const key of [
		'changeStatus',
		'changePriority',
		'changeSupportLevel',
		'changeSite',
		'changeCategory',
		'assign',
		'changeSla',
		'readInternalNotes',
		'addInternalNote'
	]) {
		assert.equal(actions[key].available, false, key);
		assert.equal(actions[key].blockedBy, 'requester-view', key);
	}
	assert.deepEqual(actions.changeStatus.targets, []);
	assert.equal(actions.readComments.available, true);
	assert.equal(actions.addComment.available, true, 'un solicitante puede comentar');
});

test('D. notas internas: ver y añadir son capabilities independientes', () => {
	const viewOnly = incidentActions(staff(), ['incidents:view_internal_notes']);
	assert.equal(viewOnly.readInternalNotes.available, true);
	assert.equal(viewOnly.addInternalNote.available, false);
	assert.equal(viewOnly.addInternalNote.blockedBy, 'missing-capability');
	const addOnly = incidentActions(staff(), ['incidents:add_internal_note']);
	assert.equal(addOnly.addInternalNote.available, true);
	assert.equal(addOnly.readInternalNotes.available, false, 'añadir no implica leer');
});

test('D. cerrada: solo reapertura entre los cambios de estado; nada más', () => {
	const actions = incidentActions(staff('closed'), ALL);
	assert.equal(actions.changeStatus.available, true);
	assert.deepEqual(actions.changeStatus.targets, ['open']);
	for (const key of [
		'changePriority',
		'changeSupportLevel',
		'changeSite',
		'changeCategory',
		'assign',
		'changeSla',
		'addComment',
		'addInternalNote'
	])
		assert.equal(actions[key].blockedBy, 'closed', key);
	assert.deepEqual(buildStatusPatch('closed', 'open'), { status: 'open' });
	assert.throws(() => buildStatusPatch('closed', 'resolved'), ApiError);
	assert.throws(
		() => buildPriorityPatch('closed', 'high'),
		ApiError,
		'no se combina con prioridad'
	);
});

test('D. matriz real de estados', () => {
	assert.deepEqual(STATUS_TRANSITIONS, {
		open: ['pending', 'resolved'],
		pending: ['open', 'resolved'],
		resolved: ['open', 'closed'],
		closed: ['open']
	});
	assert.deepEqual(incidentActions(staff('resolved'), ALL).changeStatus.targets, [
		'open',
		'closed'
	]);
	assert.throws(() => buildStatusPatch('open', 'closed'), ApiError);
});

test('D. asignación y SLA exigen su capability exacta', () => {
	const editOnly = incidentActions(staff(), ['incidents:edit']);
	assert.equal(editOnly.changePriority.available, true);
	assert.equal(editOnly.assign.blockedBy, 'missing-capability');
	assert.equal(editOnly.changeSla.blockedBy, 'missing-capability');
	assert.equal(incidentActions(staff(), ['incidents:assign']).assign.available, true);
	assert.equal(incidentActions(staff(), ['sla:assign']).changeSla.available, true);
	assert.equal(
		incidentActions(staff(), ['sla:view']).changeSla.available,
		false,
		'ver no es asignar'
	);
	assert.equal(
		incidentActions(staff(), ['organization_admin', 'technician']).changePriority.available,
		false,
		'los nombres de rol no son capabilities'
	);
});

test('D. constructor de asignación: omitido vs null, desasignar, motivo', () => {
	const team = '11111111-2222-4333-8444-555555555555';
	assert.deepEqual(buildAssignmentPatch({ assignedToUserId: null }), { assignedToUserId: null });
	assert.deepEqual(buildAssignmentPatch({ teamId: team }), { teamId: team }, 'técnico omitido');
	assert.deepEqual(
		buildAssignmentPatch({ teamId: null, assignedToUserId: null, reason: ' motivo ' }),
		{
			teamId: null,
			assignedToUserId: null,
			reason: 'motivo'
		}
	);
	assert.throws(() => buildAssignmentPatch({}), ApiError);
	assert.throws(() => buildAssignmentPatch({ teamId: 'x' }), ApiError);
	assert.throws(() => normalizeChangeReason('a'.repeat(1001)), ApiError);
	assert.equal(normalizeChangeReason(`  ${'a'.repeat(1000)}  `).length, 1000);
	assert.throws(() => normalizeChangeReason('con\u0000nulo'), ApiError);
});

test('Mutación: resultado incierto frente a error definitivo', async () => {
	assert.equal(isUncertainMutationFailure(new ApiError(0, 'NETWORK_ERROR', 'x')), true);
	assert.equal(isUncertainMutationFailure(new ApiError(201, 'INVALID_PAYLOAD', 'x')), true);
	assert.equal(isUncertainMutationFailure(new ApiError(504, 'SERVER_ERROR', 'x')), true);
	assert.equal(
		isUncertainMutationFailure(new ApiError(0, 'INVALID_INPUT', 'x')),
		false,
		'no enviado'
	);
	for (const status of [400, 401, 403, 404, 409, 413, 422, 429, 500, 503])
		assert.equal(isUncertainMutationFailure(new ApiError(status, 'X', 'x')), false, String(status));

	const channel = createMutationChannel('a');
	let sends = 0;
	const unknown = await channel.run(async () => {
		sends++;
		throw new TypeError('Failed to fetch');
	});
	assert.equal(unknown.status, 'unknown');
	assert.equal(sends, 1, 'sin reintento automático');

	// the GET presentation suggests a manual retry; the mutation one never a blind resubmit
	assert.equal(presentApiError(unknown.error).action, 'retry');
	const shown = presentMutationFailure(unknown);
	assert.equal(shown.action, 'verify');
	assert.equal(
		shown.message,
		'No se pudo confirmar el resultado. Comprueba el estado antes de repetir la acción.'
	);
	const definite = presentMutationFailure({
		status: 'error',
		error: new ApiError(409, 'INCIDENT_CLOSED', 'La incidencia está cerrada.')
	});
	assert.equal(definite.action, 'none');
	assert.equal(
		presentMutationFailure({ status: 'error', error: new ApiError(401, 'UNAUTHORIZED', 'x') })
			.action,
		'login'
	);
});

test('Seguridad: módulos UI-2A sin roles, storage, {@html} ni imports de servidor', () => {
	for (const file of [
		'src/lib/api/incident-detail.ts',
		'src/lib/api/incident-create.ts',
		'src/lib/app/incident-actions.ts',
		'src/lib/app/incident-detail-controller.ts',
		'src/lib/app/incident-create-controller.ts',
		'src/lib/app/tenant-catalog.ts',
		'src/lib/app/tenant-identity.ts',
		'src/lib/app/mutation.ts',
		'src/lib/app/request-channels.ts'
	]) {
		const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
		const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
		assert.doesNotMatch(code, /localStorage|sessionStorage|\{@html|innerHTML/, file);
		assert.doesNotMatch(code, /from ['"][^'"]*(\$lib\/server|\/server\/|drizzle)/, file);
		assert.doesNotMatch(code, /role\s*===|organization_admin|technician/, file);
		assert.doesNotMatch(code, /\/messages\b/, `${file}: no existe un endpoint /messages`);
	}
});
