export type IncidentMessageVisibility = 'public' | 'internal';
export interface IncidentMessage {
	id: string;
	organizationId: string;
	incidentId: number;
	authorUserId: string;
	visibility: IncidentMessageVisibility;
	content: string;
	createdAt: string;
}
