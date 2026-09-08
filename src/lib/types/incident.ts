import type { SupportLevel } from './support';

export type IncidentStatus = 'open' | 'pending' | 'resolved';

export type IncidentPriority = 'low' | 'medium' | 'high';

export interface Incident {
	id: number;
	organizationId?: string;
	title: string;
	client: string;
	clientUserId?: string;
	status: IncidentStatus;
	priority: IncidentPriority;
	createdAt: string;
	updatedAt?: string;
	createdByUserId?: string;
	assignedToUserId?: string | null;
	// Current operational destination, independent of the assigned user's profile.
	supportLevel?: SupportLevel;
	teamId?: string;
	description?: string;
	solution?: string;
	categoryId?: string;
}
