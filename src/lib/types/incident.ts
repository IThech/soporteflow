import type { SupportLevel } from './support';
import type { IncidentSlaSnapshot } from './sla';

export type IncidentStatus = 'open' | 'pending' | 'resolved' | 'closed';

export type IncidentClosureType = 'client_confirmed' | 'auto_closed';

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
	sla?: IncidentSlaSnapshot | null;
	resolvedAt?: string | null;
	closedAt?: string | null;
	closureType?: IncidentClosureType | null;
}
