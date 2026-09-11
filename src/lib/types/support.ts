export const supportLevels = ['N1', 'N2', 'N3'] as const;
export type SupportLevel = string;

export interface SupportLevelDefinition {
	id: string;
	organizationId: string;
	code: string;
	name: string;
	description?: string;
	order: number;
	active: boolean;
	createdAt: string;
}

export interface CreateSupportLevelInput {
	organizationId: string;
	code: string;
	name: string;
	description?: string;
	order?: number;
	active?: boolean;
}

export interface UpdateSupportLevelInput {
	id: string;
	name: string;
	description?: string;
	order?: number;
	active?: boolean;
}

// Operational area owned by an organization; independent of support level and role.
export interface SupportTeam {
	id: string;
	organizationId: string;
	name: string;
	description?: string;
	active: boolean;
	createdAt?: string;
}

export interface CreateSupportTeamInput {
	organizationId: string;
	name: string;
	description?: string;
	active?: boolean;
}

export interface UpdateSupportTeamInput {
	id: string;
	name: string;
	description?: string;
	active?: boolean;
}

export interface SupportCatalogReferences {
	userCount: number;
	activeIncidentCount: number;
}
