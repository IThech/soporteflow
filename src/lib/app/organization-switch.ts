/**
 * UI-2B — organization switcher choice. The page may refuse a change (e.g. an unsaved draft the
 * user decided to keep) by returning false; the native select must then show the active
 * organization again. Returns the value the select must be reset to, or null to leave it.
 */
export function applyOrganizationChoice(
	choose: (organizationId: string) => boolean | void,
	value: string,
	activeOrganizationId: string | null
): string | null {
	return choose(value) === false ? (activeOrganizationId ?? '') : null;
}
