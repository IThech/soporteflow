export const supportLevels = ['N1', 'N2', 'N3'] as const;
export type SupportLevel = (typeof supportLevels)[number];

// Operational area owned by an organization; independent of support level and role.
export interface SupportTeam {
	id: string;
	organizationId: string;
	name: string;
	description?: string;
	active: boolean;
}
