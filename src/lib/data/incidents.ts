import type { Incident } from '$lib/types/incident';

export const incidents: Incident[] = [
	{
		id: 1,
		title: 'El ordenador no se conecta a la red',
		client: 'Clínica Norte',
		status: 'open',
		priority: 'high',
		createdAt: '2026-08-26'
	},
	{
		id: 2,
		title: 'Configurar acceso remoto al servidor',
		client: 'Madera Viva',
		status: 'pending',
		priority: 'medium',
		createdAt: '2026-08-25'
	},
	{
		id: 3,
		title: 'Actualizar certificados de la web',
		client: 'Estudio Delta',
		status: 'resolved',
		priority: 'low',
		createdAt: '2026-08-24'
	},
	{
		id: 4,
		title: 'La impresora aparece sin conexión',
		client: 'Clínica Norte',
		status: 'open',
		priority: 'medium',
		createdAt: '2026-08-23'
	},
	{
		id: 5,
		title: 'Revisar copia de seguridad nocturna',
		client: 'Madera Viva',
		status: 'pending',
		priority: 'high',
		createdAt: '2026-08-22'
	}
];
