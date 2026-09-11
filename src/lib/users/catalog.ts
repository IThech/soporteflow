import { canAccessOrganization, hasPermission } from '$lib/auth/permissions';
import { demoUsers } from '$lib/data/users';
import { supportLevels, type SupportLevel, type SupportTeam } from '$lib/types/support';
import type {
	AdministrableUserRole,
	AppUser,
	CreateUserInput,
	UpdateUserInput
} from '$lib/types/user';

export const USERS_STORAGE_KEY = 'soporteflow-users';

export const ADMINISTRABLE_ROLES: readonly AdministrableUserRole[] = [
	'organization_admin',
	'technician',
	'client'
] as const;

export type UserLoadResult =
	| { status: 'missing'; seededUsers: AppUser[] }
	| { status: 'valid'; users: AppUser[] }
	| { status: 'corrupt'; error: string };

export type UserCatalogState =
	{ status: 'valid'; users: AppUser[] } | { status: 'corrupt'; error: string; raw: string };

export interface SupportContext {
	availableLevels?: readonly string[];
	availableTeams?: readonly SupportTeam[];
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Validates whether an individual object conforms strictly to the AppUser schema.
 */
export function isUser(item: unknown): item is AppUser {
	if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
	const u = item as Record<string, unknown>;

	if (
		typeof u.id !== 'string' ||
		!u.id.trim() ||
		typeof u.name !== 'string' ||
		!u.name.trim() ||
		typeof u.email !== 'string' ||
		!u.email.trim() ||
		!isValidEmail(u.email.trim()) ||
		typeof u.active !== 'boolean' ||
		typeof u.createdAt !== 'string' ||
		!Number.isFinite(Date.parse(u.createdAt))
	) {
		return false;
	}

	if (
		!['platform_admin', 'organization_admin', 'technician', 'client'].includes(u.role as string)
	) {
		return false;
	}

	if (u.role === 'platform_admin') {
		return (
			(u.organizationId === undefined || typeof u.organizationId === 'string') &&
			u.supportLevel === undefined &&
			u.teamId === undefined
		);
	}

	if (typeof u.organizationId !== 'string' || !u.organizationId.trim()) {
		return false;
	}

	if (u.role === 'technician' || u.role === 'organization_admin') {
		const validLevel =
			u.supportLevel === undefined ||
			(typeof u.supportLevel === 'string' &&
				supportLevels.includes(u.supportLevel as SupportLevel));
		const validTeam =
			u.teamId === undefined || (typeof u.teamId === 'string' && u.teamId.trim().length > 0);
		return validLevel && validTeam;
	}

	// client cannot have operational support level or team
	return u.supportLevel === undefined && u.teamId === undefined;
}

/**
 * Validates an entire collection of users, ensuring schema validity and uniqueness of IDs and emails.
 */
export function isUserList(value: unknown): value is AppUser[] {
	if (!Array.isArray(value)) return false;
	const ids = new Set<string>();
	const emails = new Set<string>();

	return value.every((item) => {
		if (!isUser(item)) return false;
		if (ids.has(item.id)) return false;
		ids.add(item.id);

		const normEmail = normalizeEmail(item.email);
		if (emails.has(normEmail)) return false;
		emails.add(normEmail);

		return true;
	});
}

/**
 * Loads users from localStorage, cleanly distinguishing between:
 * - missing: storage not set yet, returns demoUsers for initial seeding.
 * - valid: stored JSON is valid and safe to use.
 * - corrupt: stored JSON is malformed or invalid schema, preventing data loss.
 */
export function loadUsersResult(raw: string | null): UserLoadResult {
	if (raw === null) {
		return {
			status: 'missing',
			seededUsers: demoUsers.map((u) => ({ ...u }))
		};
	}

	try {
		const parsed: unknown = JSON.parse(raw);
		if (isUserList(parsed)) {
			return {
				status: 'valid',
				users: parsed
			};
		}
		return {
			status: 'corrupt',
			error: 'El catálogo de usuarios guardado no tiene un formato válido.'
		};
	} catch (err) {
		return {
			status: 'corrupt',
			error:
				err instanceof Error
					? `No se pudo parsear el catálogo de usuarios: ${err.message}`
					: 'Error al cargar usuarios guardados.'
		};
	}
}

/**
 * Saves users safely to storage with schema verification.
 */
export function saveUsers(storage: Storage, users: AppUser[]): void {
	if (!isUserList(users)) {
		throw new Error('La lista de usuarios no tiene un formato válido.');
	}
	storage.setItem(USERS_STORAGE_KEY, JSON.stringify(users));
}

/**
 * Filters users by an organization ID, excluding platform_admin.
 */
export function getOrganizationUsers(users: AppUser[], organizationId: string): AppUser[] {
	return users.filter((u) => u.organizationId === organizationId && u.role !== 'platform_admin');
}

/**
 * Validates technician-specific fields (supportLevel and teamId).
 */
function validateTechnicalFields(
	input: { supportLevel?: SupportLevel; teamId?: string },
	organizationId: string,
	context?: SupportContext
) {
	if (input.supportLevel) {
		const validLevels = context?.availableLevels ?? supportLevels;
		if (!validLevels.includes(input.supportLevel)) {
			throw new Error('El nivel de soporte seleccionado no es válido.');
		}
	}

	if (input.teamId) {
		if (context?.availableTeams) {
			const team = context.availableTeams.find((t) => t.id === input.teamId);
			if (!team || team.organizationId !== organizationId || !team.active) {
				throw new Error(
					'El equipo seleccionado no es válido o no está activo en esta organización.'
				);
			}
		}
	}
}

/**
 * Creates a new user within an organization following domain and security rules.
 */
export function createUser(
	actor: AppUser,
	users: AppUser[],
	input: CreateUserInput,
	context?: SupportContext
): AppUser[] {
	if (!hasPermission(actor, 'users:manage')) {
		throw new Error('No tienes permisos para gestionar usuarios.');
	}

	const targetOrgId = input.organizationId.trim();
	if (!targetOrgId || !canAccessOrganization(actor, targetOrgId)) {
		throw new Error('No tienes permiso para gestionar usuarios de otra organización.');
	}

	if ((input.role as string) === 'platform_admin') {
		throw new Error(
			'No se puede asignar el rol de administrador de plataforma desde la administración de la organización.'
		);
	}

	if (!ADMINISTRABLE_ROLES.includes(input.role)) {
		throw new Error('El rol especificado no es válido.');
	}

	const name = input.name.trim();
	if (!name || name.length < 2) {
		throw new Error('Escribe un nombre de al menos 2 caracteres.');
	}

	const email = normalizeEmail(input.email);
	if (!isValidEmail(email)) {
		throw new Error('Escribe una dirección de correo electrónico válida.');
	}

	if (users.some((u) => normalizeEmail(u.email) === email)) {
		throw new Error('Ya existe un usuario con este correo electrónico.');
	}

	const createdAt = new Date().toISOString().slice(0, 10);
	const active = input.active ?? true;

	if (input.role === 'technician' || input.role === 'organization_admin') {
		validateTechnicalFields(input, targetOrgId, context);
		const newTechnicalUser: AppUser = {
			id: crypto.randomUUID(),
			organizationId: targetOrgId,
			name,
			email,
			role: input.role,
			...(input.supportLevel ? { supportLevel: input.supportLevel } : {}),
			...(input.teamId ? { teamId: input.teamId } : {}),
			active,
			createdAt
		};
		return [...users, newTechnicalUser];
	}

	// client (no technical fields permitted)
	const newStandardUser: AppUser = {
		id: crypto.randomUUID(),
		organizationId: targetOrgId,
		name,
		email,
		role: 'client',
		active,
		createdAt
	};
	return [...users, newStandardUser];
}

/**
 * Updates an existing user with strict business rules, isolation, and auto-protection.
 */
export function updateUser(
	actor: AppUser,
	users: AppUser[],
	input: UpdateUserInput,
	context?: SupportContext
): AppUser[] {
	if (!hasPermission(actor, 'users:manage')) {
		throw new Error('No tienes permisos para gestionar usuarios.');
	}

	const target = users.find((u) => u.id === input.id);
	if (!target) {
		throw new Error('El usuario no existe.');
	}

	if (target.role === 'platform_admin') {
		throw new Error('No se puede modificar a un administrador de plataforma.');
	}

	if (!target.organizationId || !canAccessOrganization(actor, target.organizationId)) {
		throw new Error('No tienes permiso para gestionar usuarios de otra organización.');
	}

	if ((input.role as string) === 'platform_admin') {
		throw new Error(
			'No se puede asignar el rol de administrador de plataforma desde la administración de la organización.'
		);
	}

	if (!ADMINISTRABLE_ROLES.includes(input.role)) {
		throw new Error('El rol especificado no es válido.');
	}

	const name = input.name.trim();
	if (!name || name.length < 2) {
		throw new Error('Escribe un nombre de al menos 2 caracteres.');
	}

	const email = normalizeEmail(input.email);
	if (!isValidEmail(email)) {
		throw new Error('Escribe una dirección de correo electrónico válida.');
	}

	if (users.some((u) => u.id !== target.id && normalizeEmail(u.email) === email)) {
		throw new Error('Ya existe otro usuario con este correo electrónico.');
	}

	const targetOrgId = target.organizationId;
	const willBeActive = input.active ?? target.active;

	// Protection 1: An administrator cannot deactivate their own active account
	if (target.id === actor.id && !willBeActive && target.active) {
		throw new Error('No puedes desactivar tu propia cuenta activa.');
	}

	// Protection 2: Cannot leave the organization without any active organization_admin
	const isCurrentlyActiveAdmin = target.role === 'organization_admin' && target.active;
	const staysActiveAdmin = input.role === 'organization_admin' && willBeActive;
	if (isCurrentlyActiveAdmin && !staysActiveAdmin) {
		const otherActiveAdmins = users.filter(
			(u) =>
				u.id !== target.id &&
				u.organizationId === targetOrgId &&
				u.role === 'organization_admin' &&
				u.active
		);
		if (otherActiveAdmins.length === 0) {
			throw new Error('No se puede dejar la organización sin ningún administrador activo.');
		}
	}

	if (input.role === 'technician' || input.role === 'organization_admin') {
		// Preserve existing technical fields if input doesn't explicitly specify them
		const supportLevel =
			input.supportLevel !== undefined ? input.supportLevel : target.supportLevel;
		const teamId = input.teamId !== undefined ? input.teamId : target.teamId;

		validateTechnicalFields({ supportLevel, teamId }, targetOrgId, context);

		const updatedTechnicalUser: AppUser = {
			id: target.id,
			organizationId: targetOrgId,
			name,
			email,
			role: input.role,
			...(supportLevel ? { supportLevel } : {}),
			...(teamId ? { teamId } : {}),
			active: willBeActive,
			createdAt: target.createdAt
		};
		return users.map((u) => (u.id === target.id ? updatedTechnicalUser : u));
	}

	// For client: supportLevel and teamId are strictly cleaned/removed
	const updatedClient: AppUser = {
		id: target.id,
		organizationId: targetOrgId,
		name,
		email,
		role: 'client',
		active: willBeActive,
		createdAt: target.createdAt
	};
	return users.map((u) => (u.id === target.id ? updatedClient : u));
}

/**
 * Toggles a user's active status with protection against self-deactivation and last admin deactivation.
 */
export function toggleUserActive(
	actor: AppUser,
	users: AppUser[],
	targetUserId: string
): AppUser[] {
	if (!hasPermission(actor, 'users:manage')) {
		throw new Error('No tienes permisos para gestionar usuarios.');
	}

	const target = users.find((u) => u.id === targetUserId);
	if (!target) {
		throw new Error('El usuario no existe.');
	}

	if (target.role === 'platform_admin') {
		throw new Error('No se puede modificar a un administrador de plataforma.');
	}

	if (!target.organizationId || !canAccessOrganization(actor, target.organizationId)) {
		throw new Error('No tienes permiso para gestionar usuarios de otra organización.');
	}

	// If currently active, we are deactivating
	if (target.active) {
		if (target.id === actor.id) {
			throw new Error('No puedes desactivar tu propia cuenta activa.');
		}

		if (target.role === 'organization_admin') {
			const otherActiveAdmins = users.filter(
				(u) =>
					u.id !== target.id &&
					u.organizationId === target.organizationId &&
					u.role === 'organization_admin' &&
					u.active
			);
			if (otherActiveAdmins.length === 0) {
				throw new Error('No se puede desactivar al único administrador activo de la organización.');
			}
		}
	}

	return users.map((u) => (u.id === target.id ? { ...u, active: !u.active } : u));
}
