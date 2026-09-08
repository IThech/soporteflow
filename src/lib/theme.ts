export type ThemePreference = 'light' | 'dark' | 'system';
export const THEME_KEY = 'soporteflow-theme';
export function parseTheme(value: unknown): ThemePreference {
	return value === 'light' || value === 'dark' ? value : 'system';
}
export function resolveTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
	return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}
export function readTheme(storage: Pick<Storage, 'getItem'>): ThemePreference {
	try {
		return parseTheme(storage.getItem(THEME_KEY));
	} catch {
		return 'system';
	}
}
export function saveTheme(storage: Pick<Storage, 'setItem'>, preference: ThemePreference): boolean {
	try {
		storage.setItem(THEME_KEY, parseTheme(preference));
		return true;
	} catch {
		return false;
	}
}
