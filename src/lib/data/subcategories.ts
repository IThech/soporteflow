import type { Subcategory } from '$lib/types/classification';
import { demoOrganization } from './organizations';

/**
 * Subcategorías iniciales de demostración para la organización Nodhouses.
 * Contempla entre 2 y 4 subcategorías para cada una de las 6 categorías activas de Nodhouses.
 * Todos los identificadores son únicos y estables.
 * La criticidad base responde a la afectación inherente al servicio o activo.
 */
export const demoSubcategories: Subcategory[] = [
	// 1. Equipos (equipment)
	{
		id: 'sub-eq-workstation',
		organizationId: demoOrganization.id,
		categoryId: 'equipment',
		name: 'Puesto de trabajo (PC / portátil) no enciende o bloqueado',
		baseCriticality: 'medium',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-eq-peripherals',
		organizationId: demoOrganization.id,
		categoryId: 'equipment',
		name: 'Periféricos y accesorios (pantalla, teclado, ratón, dock)',
		baseCriticality: 'low',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-eq-printer',
		organizationId: demoOrganization.id,
		categoryId: 'equipment',
		name: 'Impresora o escáner no responde',
		baseCriticality: 'low',
		minPriority: null,
		active: true
	},

	// 2. Redes (network)
	{
		id: 'sub-net-wifi',
		organizationId: demoOrganization.id,
		categoryId: 'network',
		name: 'Conexión Wi-Fi inestable o sin acceso',
		baseCriticality: 'medium',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-net-cable',
		organizationId: demoOrganization.id,
		categoryId: 'network',
		name: 'Sin conexión a internet o red local cableada',
		baseCriticality: 'medium',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-net-vpn',
		organizationId: demoOrganization.id,
		categoryId: 'network',
		name: 'Fallo de conexión VPN o acceso remoto',
		baseCriticality: 'medium',
		minPriority: null,
		active: true
	},

	// 3. Cuentas y accesos (accounts)
	{
		id: 'sub-acc-password',
		organizationId: demoOrganization.id,
		categoryId: 'accounts',
		name: 'Contraseña bloqueada o restablecimiento de acceso',
		baseCriticality: 'medium',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-acc-mfa',
		organizationId: demoOrganization.id,
		categoryId: 'accounts',
		name: 'Problemas con segundo factor (2FA / MFA) o autenticador',
		baseCriticality: 'medium',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-acc-permissions',
		organizationId: demoOrganization.id,
		categoryId: 'accounts',
		name: 'Solicitud o modificación de permisos en carpetas y aplicaciones',
		baseCriticality: 'low',
		minPriority: null,
		active: true
	},

	// 4. Software (software)
	{
		id: 'sub-soft-erp',
		organizationId: demoOrganization.id,
		categoryId: 'software',
		name: 'Error crítico o bloqueo en ERP / CRM de gestión',
		baseCriticality: 'high',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-soft-office',
		organizationId: demoOrganization.id,
		categoryId: 'software',
		name: 'Fallo en correo electrónico o aplicaciones ofimáticas',
		baseCriticality: 'medium',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-soft-install',
		organizationId: demoOrganization.id,
		categoryId: 'software',
		name: 'Instalación o actualización de aplicaciones estándar',
		baseCriticality: 'low',
		minPriority: null,
		active: true
	},

	// 5. NAS y almacenamiento (storage)
	{
		id: 'sub-sto-nas-unreachable',
		organizationId: demoOrganization.id,
		categoryId: 'storage',
		name: 'Servidor NAS o carpetas de red inaccesibles',
		baseCriticality: 'high',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-sto-quota',
		organizationId: demoOrganization.id,
		categoryId: 'storage',
		name: 'Espacio en disco lleno o advertencia de cuota',
		baseCriticality: 'medium',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-sto-backup',
		organizationId: demoOrganization.id,
		categoryId: 'storage',
		name: 'Solicitud de recuperación o copia de seguridad de ficheros',
		baseCriticality: 'medium',
		minPriority: null,
		active: true
	},

	// 6. Otros (other)
	{
		id: 'sub-oth-inquiry',
		organizationId: demoOrganization.id,
		categoryId: 'other',
		name: 'Consulta o asesoramiento informático',
		baseCriticality: 'low',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-oth-audiovisual',
		organizationId: demoOrganization.id,
		categoryId: 'other',
		name: 'Incidencia con proyector, pantalla o videoconferencia',
		baseCriticality: 'low',
		minPriority: null,
		active: true
	},
	{
		id: 'sub-oth-general',
		organizationId: demoOrganization.id,
		categoryId: 'other',
		name: 'Otras incidencias no catalogadas',
		baseCriticality: 'low',
		minPriority: null,
		active: true
	}
];
