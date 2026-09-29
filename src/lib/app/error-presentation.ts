import { ApiError, defaultMessageFor, isApiError, networkApiError } from '../api/errors.ts';
import { UNKNOWN_OUTCOME_MESSAGE } from './mutation.ts';

/**
 * One mapping from ApiError to what a page shows (UI-1A, A1). Pages never write their own
 * strings per status. `action` tells the page what it may offer:
 * - 'login': 401 of the CURRENT context (callers only receive current errors) -> re-authenticate;
 * - 'retry': transient (network, 429 after cooldown, 5xx/503, invalid payload). This is a MANUAL
 *   retry of a safe READ (GET). Mutations use presentMutationFailure (never blind resubmits);
 * - 'none': permanent for this request (403, 404, 400/409/413/422 need user changes).
 * 403 never implies sign-out; 409 keeps the caller's form/state (the page decides).
 */
export interface ErrorPresentation {
	tone: 'danger' | 'warning' | 'info';
	title: string;
	message: string;
	requestId?: string;
	/** Seconds the UI must wait before offering a retry (429/503 with Retry-After). */
	retryAfterSeconds?: number;
	action: 'login' | 'retry' | 'none';
}

const TITLES: Record<ApiError['kind'], string> = {
	network: 'Sin conexión con el servidor',
	'invalid-input': 'Solicitud no válida',
	unauthenticated: 'Sesión caducada',
	forbidden: 'Acceso no permitido',
	'not-found': 'Recurso no disponible',
	conflict: 'Conflicto con el estado actual',
	'payload-too-large': 'Solicitud demasiado grande',
	unprocessable: 'No se pudo procesar la solicitud',
	'rate-limited': 'Demasiadas solicitudes',
	unavailable: 'Servicio no disponible',
	server: 'Error del servidor',
	'invalid-payload': 'Respuesta inesperada del servidor'
};

export function presentApiError(error: unknown): ErrorPresentation {
	const apiError = isApiError(error) ? error : networkApiError();
	const kind = apiError.kind;
	const action: ErrorPresentation['action'] =
		kind === 'unauthenticated'
			? 'login'
			: kind === 'network' ||
				  kind === 'rate-limited' ||
				  kind === 'server' ||
				  kind === 'unavailable' ||
				  kind === 'invalid-payload'
				? 'retry'
				: 'none';
	return {
		tone: kind === 'rate-limited' || kind === 'forbidden' ? 'warning' : 'danger',
		title: TITLES[kind],
		// Server messages are only surfaced for client-correctable errors (built by
		// apiErrorFromResponse); everything else uses the safe default text.
		message:
			kind === 'invalid-input' || kind === 'conflict' || kind === 'unprocessable'
				? apiError.message
				: defaultMessageFor(kind),
		requestId: apiError.requestId,
		retryAfterSeconds: apiError.retryAfterSeconds,
		action
	};
}

/**
 * UI-2A — presentation of a FAILED MUTATION (POST/PATCH). Unlike presentApiError (reads), it never
 * suggests repeating blindly:
 * - `unknown` (answer lost after sending): action 'verify' with UNKNOWN_OUTCOME_MESSAGE; the UI
 *   must re-check the resource before any new attempt;
 * - `error` (definite server answer): 'login' on 401; 'resubmit' only where the server certainly
 *   did not apply it and waiting/fixing may help (network before sending never reaches here;
 *   429/503/5xx); otherwise 'none'. 'resubmit' is always a MANUAL user decision, never automatic.
 */
export interface MutationFailurePresentation extends Omit<ErrorPresentation, 'action'> {
	action: 'login' | 'verify' | 'resubmit' | 'none';
}

export function presentMutationFailure(outcome: {
	status: 'error' | 'unknown';
	error: ApiError;
}): MutationFailurePresentation {
	const base = presentApiError(outcome.error);
	if (outcome.status === 'unknown')
		return {
			...base,
			tone: 'warning',
			title: 'Resultado sin confirmar',
			message: UNKNOWN_OUTCOME_MESSAGE,
			action: 'verify'
		};
	return {
		...base,
		action: base.action === 'login' ? 'login' : base.action === 'retry' ? 'resubmit' : 'none'
	};
}

/** Remaining whole seconds of a cooldown (0 when elapsed or absent). */
export function remainingSeconds(until: number | null, now: number = Date.now()): number {
	if (until === null) return 0;
	return Math.max(0, Math.ceil((until - now) / 1000));
}
