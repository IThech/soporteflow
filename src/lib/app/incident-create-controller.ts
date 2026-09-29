import type { ApiError } from '../api/errors.ts';
import type { CreateIncidentRequest } from '../api/incident-create.ts';
import type { CreatedIncidentView } from '../api/incident-detail.ts';
import { createMutationChannel, type MutationResult } from './mutation.ts';
import { tenantKey, type TenantIdentity } from './tenant-identity.ts';

/**
 * UI-2A — incident creation coordination (no UI, no navigation: UI-2B decides what to show).
 *
 * `incidents:create` does not imply reading the created incident afterwards: the server answers
 * with the creator's audience projection, and a creator without any read scope still gets the
 * requester projection. So a confirmed creation is classified:
 * - `readable`: the actor can open it now (view_all; a staff projection; or view_requested and
 *   the actor is its requester) — a UI hint, the detail read still decides;
 * - `not-readable`: created, but no read scope covers it (e.g. only incidents:create, or a
 *   view_own technician creating an unassigned incident). UI-2B must not navigate to the detail.
 * A lost answer is `unknown` (the incident may exist): never retried, never reported as success.
 * The submission is bound to the tenant it started in; another identity makes it stale.
 */

export type CreatedIncidentReadability = 'readable' | 'not-readable';

export interface CreatedIncidentOutcome {
	readonly incident: CreatedIncidentView;
	readonly readability: CreatedIncidentReadability;
}

export function createdIncidentReadability(
	incident: CreatedIncidentView,
	identity: TenantIdentity
): CreatedIncidentReadability {
	const has = (id: string) => identity.capabilities.includes(id);
	if (has('incidents:view_all') || incident.audience === 'staff') return 'readable';
	return has('incidents:view_requested') && incident.clientUserId === identity.userId
		? 'readable'
		: 'not-readable';
}

export type IncidentCreateStatus = 'idle' | 'submitting' | 'created' | 'error' | 'unknown';

export interface IncidentCreateState {
	readonly status: IncidentCreateStatus;
	/** Tenant key the controller is bound to ('' when none). */
	readonly tenant: string;
	readonly created: CreatedIncidentOutcome | null;
	readonly error: ApiError | null;
}

export type SubmitIncident = (
	organizationId: string,
	input: CreateIncidentRequest
) => Promise<CreatedIncidentView>;

export interface IncidentCreateController {
	subscribe(run: (state: IncidentCreateState) => void): () => void;
	get(): IncidentCreateState;
	/** Binds to a tenant; another identity resets the state and makes a pending submit stale. */
	setIdentity(identity: TenantIdentity | null): void;
	submit(input: CreateIncidentRequest): Promise<MutationResult<CreatedIncidentOutcome>>;
	/** Back to idle after the UI consumed an outcome (the tenant binding is kept). */
	reset(): void;
	dispose(): void;
}

const IDLE = { status: 'idle', created: null, error: null } as const;

export function createIncidentCreateController(deps: {
	submit: SubmitIncident;
}): IncidentCreateController {
	const channel = createMutationChannel();
	const listeners = new Set<(state: IncidentCreateState) => void>();
	let identity: TenantIdentity | null = null;
	let state: IncidentCreateState = { ...IDLE, tenant: '' };

	function set(next: IncidentCreateState) {
		state = next;
		for (const listener of listeners) listener(state);
	}

	return {
		subscribe(run) {
			listeners.add(run);
			run(state);
			return () => listeners.delete(run);
		},
		get: () => state,
		setIdentity(next) {
			const key = tenantKey(next);
			if (key === state.tenant) return;
			identity = next;
			channel.setContext(key);
			set({ ...IDLE, tenant: key });
		},
		async submit(input) {
			const owner = identity;
			if (!owner) return { status: 'stale' };
			if (channel.pending) return { status: 'busy' };
			const tenant = state.tenant;
			set({ ...IDLE, status: 'submitting', tenant });
			const result = await channel.run(async () => {
				const incident = await deps.submit(owner.organizationId, input);
				return { incident, readability: createdIncidentReadability(incident, owner) };
			});
			if (result.status === 'stale' || state.tenant !== tenant) return { status: 'stale' };
			if (result.status === 'success')
				set({ status: 'created', tenant, created: result.value, error: null });
			else if (result.status === 'error' || result.status === 'unknown')
				set({ status: result.status, tenant, created: null, error: result.error });
			return result;
		},
		reset() {
			if (state.status === 'submitting') return;
			set({ ...IDLE, tenant: state.tenant });
		},
		dispose() {
			channel.dispose();
			listeners.clear();
			identity = null;
			state = { ...IDLE, tenant: '' };
		}
	};
}
