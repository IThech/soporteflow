import { demoOrganization } from './organizations';
import type { ReassignmentReason } from '$lib/types/reassignment-reason';
export const initialReassignmentReasons: ReassignmentReason[] = [
	['shift', 'Fin de turno'],
	['specialty', 'Requiere otra especialidad'],
	['workload', 'Carga de trabajo'],
	['information', 'Pendiente de información'],
	['responsible', 'Derivar a otro responsable']
].map(([id, name]) => ({
	id: `reason-nodhouses-${id}`,
	organizationId: demoOrganization.id,
	name,
	active: true,
	createdAt: '2026-09-08'
}));
