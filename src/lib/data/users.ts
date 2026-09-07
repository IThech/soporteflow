import { demoOrganization } from '$lib/data/organizations';
import type { AppUser } from '$lib/types/user';

export const demoUsers: AppUser[] = [
	{
		id: 'user-platform-admin',
		name: 'Administrador SoporteFlow',
		email: 'admin@soporteflow.test',
		role: 'platform_admin',
		active: true,
		createdAt: '2026-09-07'
	},
	{
		id: 'user-nodhouses-admin',
		organizationId: demoOrganization.id,
		name: 'Administrador Nodhouses',
		email: 'admin@nodhouses.test',
		role: 'organization_admin',
		active: true,
		createdAt: '2026-09-07'
	},
	{
		id: 'user-nodhouses-technician',
		organizationId: demoOrganization.id,
		name: 'Técnico de prueba',
		email: 'tecnico@nodhouses.test',
		role: 'technician',
		active: true,
		createdAt: '2026-09-07'
	},
	{
		id: 'user-nodhouses-client',
		organizationId: demoOrganization.id,
		name: 'Cliente de prueba',
		email: 'cliente@nodhouses.test',
		role: 'client',
		active: true,
		createdAt: '2026-09-07'
	}
];
