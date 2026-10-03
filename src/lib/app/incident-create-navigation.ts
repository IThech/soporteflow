import type { ApiError } from '../api/errors.ts';
import type { CreateCatalogsState } from './incident-create-catalogs.ts';
import type { IncidentCreateState } from './incident-create-controller.ts';

/**
 * UI-2B — navigation decisions of /app/incidents/new, as plain functions the page executes
 * (goto/beforeNavigate/confirm are injected by the page; nothing here touches the router):
 * - exact destinations (list, detail, the same page for another organization, session expiry);
 * - the draft leave guard (beforeNavigate + organization switch + sign-out);
 * - whether the CURRENT state carries a session expiry (401).
 */

export const DISCARD_DRAFT_PROMPT =
	'Tienes cambios sin guardar en la nueva incidencia. Si sales, se descartarán. ¿Quieres continuar?';

// Defined with the rest of the session lifecycle; re-exported for the UI-2B contract.
export { SESSION_EXPIRED_PATH } from './sign-out.ts';

const q = (organizationId: string) => `organizationId=${encodeURIComponent(organizationId)}`;

/** Incident list of an organization (Cancel, "Ir a incidencias"). */
export function incidentListPath(organizationId: string): `/app/incidents?${string}` {
	return `/app/incidents?${q(organizationId)}`;
}

/** Creation page of an organization (after switching organization). */
export function newIncidentPath(organizationId: string): `/app/incidents/new?${string}` {
	return `/app/incidents/new?${q(organizationId)}`;
}

/** Detail of a created incident, always in the organization it was created in. */
export function incidentDetailPath(
	organizationId: string,
	incidentId: string
): `/app/incidents/${string}?${string}` {
	return `/app/incidents/${encodeURIComponent(incidentId)}?${q(organizationId)}`;
}

/**
 * A 401 of the CURRENT identity — from the submission or from an optional catalog. Stale answers
 * (another tenant/user/generation) never reach these states (UI-2A controllers), so a 401 found
 * here always belongs to the session on screen. 403/5xx stay local errors (never a sign-out).
 */
export function currentSessionExpiry(
	creator: Pick<IncidentCreateState, 'error'>,
	catalogs: CreateCatalogsState
): ApiError | null {
	if (creator.error?.status === 401) return creator.error;
	for (const view of Object.values(catalogs)) if (view.error?.status === 401) return view.error;
	return null;
}

export interface NavigationAttempt {
	to: { url: URL } | null;
	type: string;
	cancel(): void;
}

export interface DraftLeaveGuard {
	/** beforeNavigate handler: asks before discarding a dirty draft, never when entering. */
	onBeforeNavigate(attempt: NavigationAttempt): void;
	/** For actions that navigate themselves (organization switch, sign-out): may the draft go? */
	confirmDiscard(): boolean;
	/** The next navigation was already decided (confirmed, success, session expiry): let it pass. */
	allowNextNavigation(): void;
}

export function createDraftLeaveGuard(deps: {
	isDirty: () => boolean;
	/** A confirmed creation: nothing is left to lose. */
	isSettled: () => boolean;
	confirm: (message: string) => boolean;
	currentUrl: () => URL;
}): DraftLeaveGuard {
	let allowNext = false;
	const needsConfirmation = () => deps.isDirty() && !deps.isSettled();
	return {
		onBeforeNavigate(attempt) {
			if (allowNext) {
				allowNext = false;
				return;
			}
			const current = deps.currentUrl();
			const target = attempt.to?.url;
			// Same page and organization (e.g. canonical URL rewrite): nothing is discarded.
			if (
				target &&
				target.pathname === current.pathname &&
				target.searchParams.get('organizationId') === current.searchParams.get('organizationId')
			)
				return;
			if (!needsConfirmation()) return;
			// Closing/reloading the tab: cancelling makes the browser show its own prompt.
			if (attempt.type === 'leave') return attempt.cancel();
			if (!deps.confirm(DISCARD_DRAFT_PROMPT)) attempt.cancel();
		},
		confirmDiscard() {
			return !needsConfirmation() || deps.confirm(DISCARD_DRAFT_PROMPT);
		},
		allowNextNavigation() {
			allowNext = true;
		}
	};
}
