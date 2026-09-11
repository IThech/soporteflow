import type { IncidentCategory } from '$lib/types/category';
import { demoSupportTeam, demoSupportTeams } from './teams';

export const initialCategories: IncidentCategory[] = [
	{
		id: 'equipment',
		name: 'Equipos',
		description: 'Ordenadores, monitores y periféricos.',
		active: true,
		defaultSupportLevel: 'N1',
		defaultTeamId: demoSupportTeam.id
	},
	{
		id: 'network',
		name: 'Redes',
		description: 'Conexión a internet, Wi-Fi y red local.',
		active: true,
		defaultSupportLevel: 'N2',
		defaultTeamId: demoSupportTeams[1]?.id ?? demoSupportTeam.id
	},
	{
		id: 'accounts',
		name: 'Cuentas y accesos',
		description: 'Usuarios, permisos y problemas de acceso.',
		active: true,
		defaultSupportLevel: 'N1',
		defaultTeamId: demoSupportTeam.id
	},
	{
		id: 'software',
		name: 'Software',
		description: 'Instalación, configuración y fallos de aplicaciones.',
		active: true,
		defaultSupportLevel: 'N1',
		defaultTeamId: demoSupportTeam.id
	},
	{
		id: 'storage',
		name: 'NAS y almacenamiento',
		description: 'Archivos compartidos y dispositivos de almacenamiento.',
		active: true,
		defaultSupportLevel: 'N2',
		defaultTeamId: demoSupportTeams[1]?.id ?? demoSupportTeam.id
	},
	{
		id: 'other',
		name: 'Otros',
		description: 'Casos que no encajan en las categorías disponibles.',
		active: true
	}
];
