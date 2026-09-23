import { json, type RequestHandler } from '@sveltejs/kit';
import { getAuth } from '$lib/server/auth/instance';

export const GET: RequestHandler = async (event) => {
	const auth = getAuth();
	if (!auth) {
		return json(
			{
				error: {
					code: 'UNAVAILABLE',
					message: 'Authentication is disabled.'
				}
			},
			{ status: 503 }
		);
	}

	return auth.handler(event.request);
};

export const POST: RequestHandler = async (event) => {
	const auth = getAuth();
	if (!auth) {
		return json(
			{
				error: {
					code: 'UNAVAILABLE',
					message: 'Authentication is disabled.'
				}
			},
			{ status: 503 }
		);
	}

	const subpath = event.params.all?.replace(/\/$/, '');

	if (subpath === 'sign-in/email') {
		const response = await auth.handler(event.request);

		// Non-200 responses (e.g. 400, 401, 429) from Better Auth are preserved as-is.
		if (response.status !== 200) {
			return response;
		}

		// For a 200 OK login response, fail-closed sanitization is strictly enforced.
		// The session token is strictly transported via HttpOnly cookie and must never appear in the body.
		try {
			if (!response.headers.get('content-type')?.includes('application/json')) {
				throw new Error('Expected JSON response from auth handler');
			}

			const data = await response.json();
			if (!data || typeof data !== 'object') {
				throw new Error('Malformed JSON payload from auth handler');
			}

			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { token: _token, ...safeData } = data;
			const headers = new Headers(response.headers);
			headers.set('content-type', 'application/json');

			return new Response(JSON.stringify(safeData), {
				status: 200,
				statusText: response.statusText,
				headers
			});
		} catch {
			// Fail-closed: Never leak the original response, body, token or session cookie on failure.
			return json(
				{
					error: {
						code: 'INTERNAL_ERROR',
						message: 'Internal server error.'
					}
				},
				{ status: 500 }
			);
		}
	}

	return auth.handler(event.request);
};
