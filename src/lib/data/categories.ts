import type { IncidentCategory } from '$lib/types/category';

export const initialCategories: IncidentCategory[] = [
	{
		id: 'equipment',
		name: 'Equipos',
		description: 'Ordenadores, monitores y periféricos.',
		active: true
	},
	{
		id: 'network',
		name: 'Redes',
		description: 'Conexión a internet, Wi-Fi y red local.',
		active: true
	},
	{
		id: 'accounts',
		name: 'Cuentas y accesos',
		description: 'Usuarios, permisos y problemas de acceso.',
		active: true
	},
	{
		id: 'software',
		name: 'Software',
		description: 'Instalación, configuración y fallos de aplicaciones.',
		active: true
	},
	{
		id: 'storage',
		name: 'NAS y almacenamiento',
		description: 'Archivos compartidos y dispositivos de almacenamiento.',
		active: true
	},
	{
		id: 'other',
		name: 'Otros',
		description: 'Casos que no encajan en las categorías disponibles.',
		active: true
	}
];
