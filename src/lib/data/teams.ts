import { demoOrganization } from './organizations';
import type { SupportTeam } from '$lib/types/support';

export const demoSupportTeam: SupportTeam = {
	id: 'team-nodhouses-support',
	organizationId: demoOrganization.id,
	name: 'Soporte',
	description: 'Atención técnica general de Nodhouses.',
	active: true
};
export const demoSupportTeams: SupportTeam[] = [
	demoSupportTeam,
	{
		id: 'team-nodhouses-operations',
		organizationId: demoOrganization.id,
		name: 'Operaciones Nodhouses',
		description: 'Equipo demo de coordinación operativa.',
		active: true
	}
];
