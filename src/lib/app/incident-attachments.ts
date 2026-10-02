import { writable } from 'svelte/store';
import { tenantKey, type TenantIdentity } from './tenant-identity.ts';
import {
	listIncidentAttachments,
	uploadIncidentAttachment,
	downloadIncidentAttachment
} from '../api/incident-attachments.ts';
import { ApiError, isAbortError } from '../api/errors.ts';
import type { IncidentAttachment } from '../attachments.ts';
export function createAttachmentController(
	deps = {
		list: listIncidentAttachments,
		upload: uploadIncidentAttachment,
		download: downloadIncidentAttachment
	},
	onExpired: () => void = () => {}
) {
	let target: { identity: TenantIdentity; incidentId: string } | null = null;
	let epoch = 0;
	let readSequence = 0;
	let abort = new AbortController();
	let busy = false;
	const empty = () => ({
		items: [] as IncidentAttachment[],
		loading: false,
		busy: false,
		error: null as string | null,
		unknown: false
	});
	let state = empty();
	const store = writable(state);
	const set = (patch: Partial<typeof state>) => {
		state = { ...state, ...patch };
		store.set(state);
	};
	function fail(error: unknown, mutation: boolean) {
		if (error instanceof ApiError && error.status === 401) {
			epoch++;
			abort.abort();
			target = null;
			busy = false;
			set(empty());
			onExpired();
			return;
		}
		const uncertain =
			mutation &&
			(!(error instanceof ApiError) ||
				error.status === 0 ||
				error.status === 502 ||
				error.status === 504 ||
				error.code === 'UPLOAD_OUTCOME_UNKNOWN' ||
				error.code === 'INVALID_PAYLOAD');
		set({
			error: uncertain
				? 'No se pudo confirmar la subida. Comprueba el listado antes de repetirla.'
				: error instanceof ApiError
					? error.message
					: 'No se pudo completar la operación.',
			unknown: mutation ? uncertain : state.unknown,
			...(error instanceof ApiError && [403, 404].includes(error.status) ? { items: [] } : {})
		});
	}
	async function load() {
		if (!target) return;
		const captured = target;
		const generation = epoch;
		const sequence = ++readSequence;
		set({ loading: true, error: null });
		try {
			const items = await deps.list(
				captured.identity.organizationId,
				captured.incidentId,
				abort.signal
			);
			if (generation === epoch && sequence === readSequence) set({ items, unknown: false });
		} catch (e) {
			if (generation === epoch && sequence === readSequence && !isAbortError(e)) fail(e, false);
		} finally {
			if (generation === epoch && sequence === readSequence) set({ loading: false });
		}
	}
	return {
		subscribe: store.subscribe,
		setTarget(identity: TenantIdentity | null, incidentId: string) {
			if (
				target &&
				identity &&
				tenantKey(target.identity) === tenantKey(identity) &&
				target.incidentId === incidentId
			)
				return;
			epoch++;
			abort.abort();
			abort = new AbortController();
			busy = false;
			target = identity ? { identity, incidentId } : null;
			set(empty());
			if (target) void load();
		},
		load,
		async upload(file: File) {
			if (!target || busy || state.unknown) return false;
			const captured = target;
			const generation = epoch;
			busy = true;
			set({ busy: true, error: null });
			try {
				await deps.upload(
					captured.identity.organizationId,
					captured.incidentId,
					file,
					abort.signal
				);
				if (generation !== epoch) return false;
				await load();
				return generation === epoch;
			} catch (e) {
				if (generation === epoch && !isAbortError(e)) fail(e, true);
				return false;
			} finally {
				if (generation === epoch) {
					busy = false;
					set({ busy: false });
				}
			}
		},
		async download(id: string) {
			if (!target) return null;
			const captured = target;
			const generation = epoch;
			try {
				const blob = await deps.download(
					captured.identity.organizationId,
					captured.incidentId,
					id,
					abort.signal
				);
				return generation === epoch ? blob : null;
			} catch (e) {
				if (generation === epoch && !isAbortError(e)) fail(e, false);
				return null;
			}
		},
		dispose() {
			epoch++;
			abort.abort();
			target = null;
			set(empty());
		}
	};
}
