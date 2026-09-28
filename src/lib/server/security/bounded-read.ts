/** Legacy non-paginated reads: bound SQL, never silently truncate a successful response. */
export const MAX_UNPAGINATED_ROWS = 500;
export class ResultLimitError extends Error {
	constructor() {
		super('RESULT_LIMIT_EXCEEDED');
		this.name = 'ResultLimitError';
	}
}
export async function boundedRows<T>(query: {
	limit: (count: number) => PromiseLike<T[]>;
}): Promise<T[]> {
	const rows = await query.limit(MAX_UNPAGINATED_ROWS + 1);
	if (rows.length > MAX_UNPAGINATED_ROWS) throw new ResultLimitError();
	return rows;
}
export function resultLimitFailure(error: unknown): Response | null {
	return error instanceof ResultLimitError
		? Response.json(
				{
					error: {
						code: 'RESULT_LIMIT_EXCEEDED',
						message: 'Result set is too large. Narrow the query or use pagination.'
					}
				},
				{ status: 422, headers: { 'Cache-Control': 'private, no-store' } }
			)
		: null;
}
