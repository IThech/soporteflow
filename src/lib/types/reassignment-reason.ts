export interface ReassignmentReason {
	id: string;
	organizationId: string;
	name: string;
	description?: string;
	active: boolean;
	createdAt: string;
	updatedAt?: string;
}
