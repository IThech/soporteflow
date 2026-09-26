import type { MembershipRecord, MembershipRoleRecord } from '$lib/server/services/memberships';

export {
	failure,
	onlyKeys,
	readJsonObject,
	requireCapability,
	requireDelegatingActor,
	roleServiceFailure as adminServiceFailure,
	success,
	uuid
} from '../roles/http';

/** Explicit allowlist for assigned-role metadata. */
export function toMembershipRoleDto(role: MembershipRoleRecord) {
	return {
		id: role.id,
		code: role.code,
		name: role.name,
		active: role.active,
		isCustom: role.isCustom
	};
}

/** Explicit allowlist: never organizationId, credentials, sessions or auth-provider fields. */
export function toMembershipDto(membership: MembershipRecord) {
	return {
		id: membership.id,
		user: {
			id: membership.user.id,
			name: membership.user.name,
			email: membership.user.email,
			active: membership.user.active
		},
		active: membership.active,
		roles: membership.roles.map(toMembershipRoleDto)
	};
}
