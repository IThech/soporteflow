export type IncidentStatus = 'open' | 'pending' | 'resolved';

export type IncidentPriority = 'low' | 'medium' | 'high';

export interface Incident {
	id: number;
	title: string;
	client: string;
	status: IncidentStatus;
	priority: IncidentPriority;
	createdAt: string;
	description?: string;
	solution?: string;
}
