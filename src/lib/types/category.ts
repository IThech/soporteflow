export interface IncidentCategory {
	id: string;
	organizationId?: string;
	name: string;
	description: string;
	active: boolean;
	defaultSupportLevel?: string | null;
	defaultTeamId?: string | null;
}
