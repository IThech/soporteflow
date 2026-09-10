import { demoOrganization } from './organizations';
import type { SlaPolicy } from '$lib/types/sla';

export const demoSlaPolicies: SlaPolicy[] = [
	{
		id: 'sla-nodhouses-default',
		organizationId: demoOrganization.id,
		name: 'SLA Estándar Nodhouses',
		description: 'Compromiso general de atención y resolución para casos ordinarios.',
		active: true,
		isDefault: true,
		categoryId: null,
		priority: null,
		firstResponseMinutes: 240, // 4 horas naturales
		resolutionMinutes: 1440, // 24 horas naturales
		createdAt: '2026-09-08T08:00:00.000Z'
	},
	{
		id: 'sla-nodhouses-high-priority',
		organizationId: demoOrganization.id,
		name: 'SLA Prioridad Alta',
		description: 'Atención preferente para cualquier incidencia calificada con prioridad alta.',
		active: true,
		isDefault: false,
		categoryId: null,
		priority: 'high',
		firstResponseMinutes: 60, // 1 hora natural
		resolutionMinutes: 480, // 8 horas naturales
		createdAt: '2026-09-08T08:05:00.000Z'
	},
	{
		id: 'sla-nodhouses-network-high',
		organizationId: demoOrganization.id,
		name: 'SLA Crítico de Redes',
		description:
			'Respuesta urgente ante cortes de conectividad o incidentes de red de alta prioridad.',
		active: true,
		isDefault: false,
		categoryId: 'network',
		priority: 'high',
		firstResponseMinutes: 30, // 30 minutos naturales
		resolutionMinutes: 240, // 4 horas naturales
		createdAt: '2026-09-08T08:10:00.000Z'
	},
	{
		id: 'sla-nodhouses-equipment',
		organizationId: demoOrganization.id,
		name: 'SLA Soporte de Equipos',
		description: 'Compromiso específico para hardware y periféricos.',
		active: true,
		isDefault: false,
		categoryId: 'equipment',
		priority: null,
		firstResponseMinutes: 120, // 2 horas naturales
		resolutionMinutes: 1440, // 24 horas naturales
		createdAt: '2026-09-08T08:15:00.000Z'
	}
];
