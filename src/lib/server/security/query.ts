/** Reject unknown and duplicate query keys before interpreting values. */
export function onlyKeys(params: URLSearchParams, allowed: readonly string[]): boolean {
	for (const key of params.keys())
		if (!allowed.includes(key) || params.getAll(key).length !== 1) return false;
	return true;
}
