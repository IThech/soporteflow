import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type * as schema from './schema';

export type User = InferSelectModel<typeof schema.users>;
export type NewUser = InferInsertModel<typeof schema.users>;

export type UserEmail = InferSelectModel<typeof schema.userEmails>;
export type NewUserEmail = InferInsertModel<typeof schema.userEmails>;

export type Organization = InferSelectModel<typeof schema.organizations>;
export type NewOrganization = InferInsertModel<typeof schema.organizations>;

export type Membership = InferSelectModel<typeof schema.memberships>;
export type NewMembership = InferInsertModel<typeof schema.memberships>;

export type Department = InferSelectModel<typeof schema.departments>;
export type NewDepartment = InferInsertModel<typeof schema.departments>;

export type Site = InferSelectModel<typeof schema.sites>;
export type NewSite = InferInsertModel<typeof schema.sites>;

export type Team = InferSelectModel<typeof schema.teams>;
export type NewTeam = InferInsertModel<typeof schema.teams>;

export type TeamMembership = InferSelectModel<typeof schema.teamMemberships>;
export type NewTeamMembership = InferInsertModel<typeof schema.teamMemberships>;

export type TeamServiceDepartment = InferSelectModel<typeof schema.teamServiceDepartments>;
export type NewTeamServiceDepartment = InferInsertModel<typeof schema.teamServiceDepartments>;

export type Permission = InferSelectModel<typeof schema.permissions>;
export type NewPermission = InferInsertModel<typeof schema.permissions>;

export type RoleTemplate = InferSelectModel<typeof schema.roleTemplates>;
export type NewRoleTemplate = InferInsertModel<typeof schema.roleTemplates>;

export type RoleTemplatePermission = InferSelectModel<typeof schema.roleTemplatePermissions>;
export type NewRoleTemplatePermission = InferInsertModel<typeof schema.roleTemplatePermissions>;

export type Role = InferSelectModel<typeof schema.roles>;
export type NewRole = InferInsertModel<typeof schema.roles>;

export type RolePermission = InferSelectModel<typeof schema.rolePermissions>;
export type NewRolePermission = InferInsertModel<typeof schema.rolePermissions>;

export type RoleAssignment = InferSelectModel<typeof schema.roleAssignments>;
export type NewRoleAssignment = InferInsertModel<typeof schema.roleAssignments>;

export type Module = InferSelectModel<typeof schema.modules>;
export type NewModule = InferInsertModel<typeof schema.modules>;

export type OrganizationModule = InferSelectModel<typeof schema.organizationModules>;
export type NewOrganizationModule = InferInsertModel<typeof schema.organizationModules>;
