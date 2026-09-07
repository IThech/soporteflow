export type UserRole = 'platform_admin' | 'organization_admin' | 'technician' | 'client';

export interface AppUser {
	id: string;
	organizationId?: string;
	name: string;
	email: string;
	role: UserRole;
	active: boolean;
	createdAt: string;
}
