import { isApiError, networkApiError, type ApiError } from '../api/errors.ts';

/**
 * UI-2B — sign-out outcome for the app pages (shared by /app, /app/incidents and
 * /app/incidents/new). `signOut()` already treats a 401 (the session no longer exists) as done
 * and throws on any real failure (network, 5xx/503, other statuses). A failure must NOT look like
 * a sign-out: the page keeps its valid state, stays where it is and offers a manual retry.
 */
export type SignOutResult = { ok: true } | { ok: false; error: ApiError };

export const SIGN_OUT_FAILED_MESSAGE =
	'No se pudo cerrar la sesión. Comprueba tu conexión e inténtalo de nuevo.';

export async function attemptSignOut(send: () => Promise<void>): Promise<SignOutResult> {
	try {
		await send();
		return { ok: true };
	} catch (error) {
		return { ok: false, error: isApiError(error) ? error : networkApiError() };
	}
}
