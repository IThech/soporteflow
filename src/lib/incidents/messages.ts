import { hasPermission } from '$lib/auth/permissions';
import { canViewIncident } from '$lib/auth/record-access';
import { incidentOrganizationId } from './assignment';
import type { AppUser } from '$lib/types/user';
import type { Incident } from '$lib/types/incident';
import type { IncidentMessage, IncidentMessageVisibility } from '$lib/types/incident-message';
import { generateId } from '$lib/utils/id';

export const INTERNAL_NOTE_MAX_LENGTH = 4000;

export function canCreateMessage(
	actor: AppUser,
	incident: Incident,
	visibility: IncidentMessageVisibility
): boolean {
	return (
		canUseMessages(actor, incident, visibility) &&
		(visibility === 'public' ||
			(hasPermission(actor, 'incidents:add_internal_note') && incident.status !== 'closed'))
	);
}

export function validateNewMessageContent(
	visibility: IncidentMessageVisibility,
	content: string
): void {
	if (!content.trim()) throw new Error('Escribe un mensaje antes de enviarlo.');
	if (visibility === 'internal' && content.trim().length > INTERNAL_NOTE_MAX_LENGTH)
		throw new Error('La nota interna no puede superar los 4.000 caracteres.');
}

export function canUseMessages(
	actor: AppUser,
	incident: Incident,
	visibility: IncidentMessageVisibility
): boolean {
	return (
		canViewIncident(actor, incident) &&
		(visibility === 'public' ||
			(visibility === 'internal' && hasPermission(actor, 'incidents:view_internal_notes')))
	);
}
export function visibleMessages(
	actor: AppUser,
	incident: Incident,
	messages: IncidentMessage[]
): IncidentMessage[] {
	return messages
		.filter(
			(message) =>
				message.incidentId === incident.id &&
				message.organizationId === incidentOrganizationId(incident) &&
				canUseMessages(actor, incident, message.visibility)
		)
		.toSorted(
			(a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)
		);
}
export function createMessage(
	actor: AppUser,
	incident: Incident,
	visibility: IncidentMessageVisibility,
	content: string,
	existing: IncidentMessage[]
): IncidentMessage {
	if (!canCreateMessage(actor, incident, visibility))
		throw new Error('No tienes permiso para enviar este mensaje.');
	const clean = content.trim();
	validateNewMessageContent(visibility, clean);
	const id = generateId();
	if (existing.some((message) => message.id === id))
		throw new Error('No se pudo generar un identificador único. Inténtalo de nuevo.');
	return {
		id,
		organizationId: incidentOrganizationId(incident),
		incidentId: incident.id,
		authorUserId: actor.id,
		visibility,
		content: clean,
		createdAt: new Date().toISOString()
	};
}
export function messageAuthor(message: IncidentMessage, users: AppUser[]): string {
	const user = users.find(
		(user) =>
			user.id === message.authorUserId &&
			(user.organizationId === message.organizationId || user.role === 'platform_admin')
	);
	if (!user) return 'Usuario no disponible';
	const roles = {
		technician: 'Técnico',
		organization_admin: 'Administrador',
		platform_admin: 'Administrador de plataforma',
		client: 'Cliente'
	};
	return `${user.name} · ${roles[user.role]}`;
}
