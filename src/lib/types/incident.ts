import type { SupportLevel } from './support';
import type { IncidentSlaSnapshot } from './sla';
import type { ClassificationSnapshot } from './classification';

export type IncidentStatus = 'open' | 'pending' | 'resolved' | 'closed';

export type IncidentClosureType = 'client_confirmed' | 'auto_closed';

export type IncidentPriority = 'low' | 'medium' | 'high' | 'urgent';

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
	subcategoryId?: string | null;
	classification?: ClassificationSnapshot | null;
	siteId?: string | null;
	sla?: IncidentSlaSnapshot | null;
	resolvedAt?: string | null;
	closedAt?: string | null;
	closureType?: IncidentClosureType | null;
}
