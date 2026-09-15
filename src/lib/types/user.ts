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

// Technicians and organization administrators can have optional operational support level, team, and site assignments.
// Platform administrators and clients cannot have operational fields.
export type AppUser = UserIdentity &
	(
		| {
				role: 'technician' | 'organization_admin';
				supportLevel?: SupportLevel;
				teamId?: string;
				siteIds?: string[];
		  }
		| {
				role: 'platform_admin' | 'client';
				supportLevel?: never;
				teamId?: never;
				siteIds?: never;
		  }
	);

export type AdministrableUserRole = 'organization_admin' | 'technician' | 'client';

export interface CreateUserInput {
	organizationId: string;
	name: string;
	email: string;
	role: AdministrableUserRole;
	supportLevel?: SupportLevel;
	teamId?: string;
	siteIds?: string[];
	active?: boolean;
}

export interface UpdateUserInput {
	id: string;
	name: string;
	email: string;
	role: AdministrableUserRole;
	supportLevel?: SupportLevel;
	teamId?: string;
	siteIds?: string[];
	active?: boolean;
}
