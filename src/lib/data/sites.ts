import { demoOrganization } from './organizations';
import type { Site } from '$lib/types/site';

export const demoSites: Site[] = [
	{
		id: 'site-nodhouses-central',
		organizationId: demoOrganization.id,
		name: 'Sede Central',
		description: 'Oficinas centrales y centro de coordinación Nodhouses.',
		active: true,
		createdAt: '2026-09-01'
	},
	{
		id: 'site-nodhouses-valencia',
		organizationId: demoOrganization.id,
		name: 'Delegación Valencia',
		description: 'Centro de operaciones Levante.',
		active: true,
		createdAt: '2026-09-01'
	},
	{
		id: 'site-nodhouses-barcelona',
		organizationId: demoOrganization.id,
		name: 'Delegación Barcelona',
		description: 'Oficina técnica Cataluña.',
		active: true,
		createdAt: '2026-09-01'
	}
];
