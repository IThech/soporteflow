/**
 * Determines whether local private DEV attachment storage is permitted.
 *
 * Rules:
 * 1. ATTACHMENT_DEV_ROOT must be non-empty.
 * 2. Explicit production deployment (DEPLOYMENT_ENV=production|prod) always blocks DEV storage.
 * 3. Explicit dev deployment (DEPLOYMENT_ENV=dev|development|test|local) allows DEV storage
 *    even when NODE_ENV=production (standard for SvelteKit built server in SoporteFlow DEV).
 * 4. When DEPLOYMENT_ENV is unset, fallback to NODE_ENV: non-production allows DEV storage,
 *    while NODE_ENV=production blocks it to prevent accidental exposure in unconfigured production.
 */
export function isDevStorageAllowed(environment: {
	DEPLOYMENT_ENV?: string;
	NODE_ENV?: string;
	ATTACHMENT_DEV_ROOT?: string;
}): boolean {
	const root = environment.ATTACHMENT_DEV_ROOT?.trim();
	if (!root) return false;
	const deploymentEnv = environment.DEPLOYMENT_ENV?.trim().toLowerCase();
	if (deploymentEnv === 'production' || deploymentEnv === 'prod') return false;
	if (
		deploymentEnv === 'dev' ||
		deploymentEnv === 'development' ||
		deploymentEnv === 'test' ||
		deploymentEnv === 'local'
	) {
		return true;
	}
	const nodeEnv = environment.NODE_ENV?.trim().toLowerCase();
	return nodeEnv !== 'production';
}
