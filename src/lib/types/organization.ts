export type OrganizationStatus = 'trial' | 'active' | 'suspended';

export interface Organization {
	id: string;
	name: string;
	slug: string;
	status: OrganizationStatus;
	createdAt: string;
}
