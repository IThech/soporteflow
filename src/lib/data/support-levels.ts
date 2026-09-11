import { demoOrganization } from './organizations';
import type { SupportLevelDefinition } from '$lib/types/support';

export const demoSupportLevels: SupportLevelDefinition[] = [
	{
		id: 'lvl-nodhouses-n1',
		organizationId: demoOrganization.id,
		code: 'N1',
		name: 'Primera línea',
		description: 'Atención técnica inicial y triaje.',
		order: 1,
		active: true,
		createdAt: '2026-09-01'
	},
	{
		id: 'lvl-nodhouses-n2',
		organizationId: demoOrganization.id,
		code: 'N2',
		name: 'Soporte avanzado',
		description: 'Diagnóstico técnico especializado y resolución de incidentes complejos.',
		order: 2,
		active: true,
		createdAt: '2026-09-01'
	},
	{
		id: 'lvl-nodhouses-n3',
		organizationId: demoOrganization.id,
		code: 'N3',
		name: 'Especialistas',
		description: 'Escalado crítico, infraestructura y desarrollo.',
		order: 3,
		active: true,
		createdAt: '2026-09-01'
	}
];
