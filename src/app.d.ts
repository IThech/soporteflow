import type { AuthenticatedPrincipal } from './lib/server/auth/principal';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** Undefined before resolution; null when resolution denies authentication. */
			principal?: AuthenticatedPrincipal | null;
			/** 5.4W-E: server-generated correlation id (UUID v4), also sent as X-Request-ID. */
			requestId?: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
