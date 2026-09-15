export interface Site {
	id: string;
	organizationId: string;
	name: string;
	description?: string;
	active: boolean;
	createdAt: string;
}

export interface CreateSiteInput {
	organizationId: string;
	name: string;
	description?: string;
	active?: boolean;
}

export interface UpdateSiteInput {
	id: string;
	name: string;
	description?: string;
	active?: boolean;
}

export interface SiteReferences {
	userCount: number;
	activeIncidentCount: number;
}
