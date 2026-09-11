export type NotificationType =
	| 'incident_assigned'
	| 'incident_reassigned'
	| 'incident_escalated'
	| 'incident_comment'
	| 'incident_internal_note'
	| 'incident_status_changed'
	| 'incident_resolved'
	| 'incident_reopened'
	| 'incident_closed';

export interface Notification {
	id: string;
	organizationId: string;
	recipientUserId: string;
	type: NotificationType;
	incidentId: number;
	title: string;
	message: string;
	createdAt: string;
	readAt: string | null;
}

export interface DynamicSlaAlert {
	id: string;
	incidentId: number;
	target: 'first_response' | 'resolution';
	stage: 'approaching' | 'breached';
	title: string;
	message: string;
	dueAt: string;
}
