import type { Organization } from '$lib/types/organization';

export const demoOrganization: Organization = {
	id: 'org-nodhouses',
	name: 'Nodhouses',
	slug: 'nodhouses',
	status: 'trial',
	createdAt: '2026-09-07'
};

export const organizations: Organization[] = [demoOrganization];
