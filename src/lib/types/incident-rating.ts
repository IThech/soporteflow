export interface IncidentRating {
	id: string;
	organizationId: string;
	incidentId: number;
	/** The exact ISO 8601 UTC timestamp of the resolution cycle being evaluated */
	resolvedAt: string;
	/** Snapshot of the technician assigned/responsible for this resolution */
	technicianUserId: string;
	clientUserId: string;
	/** Rating from 1 (lowest) to 5 (highest) */
	rating: number;
	comment?: string;
	createdAt: string;
}
