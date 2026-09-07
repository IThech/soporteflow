import { demoOrganization } from '$lib/data/organizations';
import { demoUsers } from '$lib/data/users';

// Temporary, in-memory demo session. Replace with real authentication later.
export const demoSessionUsers = demoUsers.filter(
	(user) =>
		user.active &&
		user.organizationId === demoOrganization.id &&
		['organization_admin', 'technician', 'client'].includes(user.role)
);
export const defaultDemoUser = demoSessionUsers.find((user) => user.role === 'organization_admin')!;
