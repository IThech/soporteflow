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

// Technicians and organization administrators can have optional operational support level and team assignments.
// Platform administrators and clients cannot have support level or team.
export type AppUser = UserIdentity &
	(
		| { role: 'technician' | 'organization_admin'; supportLevel?: SupportLevel; teamId?: string }
		| {
				role: 'platform_admin' | 'client';
				supportLevel?: never;
				teamId?: never;
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
	active?: boolean;
}

export interface UpdateUserInput {
	id: string;
	name: string;
	email: string;
	role: AdministrableUserRole;
	supportLevel?: SupportLevel;
	teamId?: string;
	active?: boolean;
}
