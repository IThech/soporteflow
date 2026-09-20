import type { AuthenticatedPrincipal } from './lib/server/auth/principal';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** Undefined before resolution; null when resolution denies authentication. */
			principal?: AuthenticatedPrincipal | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
