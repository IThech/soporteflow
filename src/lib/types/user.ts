import type { SupportLevel } from './support';

export type UserRole = 'platform_admin' | 'organization_admin' | 'technician' | 'client';

interface UserIdentity {
	id: string;
	organizationId?: string;
	name: string;
	email: string;
	active: boolean;
	createdAt: string;
}

// Organization administrators may also perform technical work.
// Missing operational fields preserve compatibility with existing users.
export type AppUser = UserIdentity &
	(
		| { role: 'organization_admin' | 'technician'; supportLevel?: SupportLevel; teamId?: string }
		| { role: 'platform_admin' | 'client'; supportLevel?: never; teamId?: never }
	);
