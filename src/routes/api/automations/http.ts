import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import { failure, success, onlyKeys, requireCapability, uuid } from '../roles/http';
import { AutomationRuleError } from '$lib/automation/rules';
import * as rules from '$lib/server/services/automation-rules';
type Operation = 'list' | 'create' | 'get' | 'patch' | 'disable' | 'executions';
async function body(request: Request) {
	if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	let size = 0,
		text = '';
	const decoder = new TextDecoder();
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.length;
			if (size > 16384) {
				await reader.cancel();
				return null;
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	} finally {
		reader.releaseLock();
	}
}
export async function handle(event: RequestEvent, op: Operation): Promise<Response> {
	try {
		const q = event.url.searchParams,
			org = q.get('organizationId'),
			id = event.params.id;
		if (
			!org ||
			!uuid.test(org) ||
			!onlyKeys(q, [
				'organizationId',
				...(['list', 'executions'].includes(op) ? ['limit', 'cursor'] : [])
			])
		)
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		if (['get', 'patch', 'disable', 'executions'].includes(op) && (!id || !uuid.test(id)))
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		const mutation = ['create', 'patch', 'disable'].includes(op);
		if (mutation && event.request.headers.get('origin') !== event.url.origin)
			return failure(403, 'FORBIDDEN', 'Permission denied.');
		if (op === 'disable' && event.request.body !== null)
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		const denied = await requireCapability(
			event.request.headers,
			org,
			mutation ? 'automations:manage' : 'automations:view'
		);
		if (denied) return denied;
		if (op === 'list') return success(await rules.listAutomationRules(db, org, q));
		if (op === 'get') return success({ rule: await rules.getAutomationRule(db, org, id!) });
		if (op === 'executions') return success(await rules.listAutomationExecutions(db, org, id!, q));
		if (op === 'disable') {
			await rules.updateAutomationRule(db, org, id!, { active: false });
			return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
		}
		const input = await body(event.request);
		if (!input) return failure(400, 'INVALID_INPUT', 'Invalid request.');
		if (op === 'patch')
			return success({ rule: await rules.updateAutomationRule(db, org, id!, input) });
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		return success(
			{ rule: await rules.createAutomationRule(db, org, principal.userId, input) },
			201
		);
	} catch (error) {
		if (error instanceof AutomationRuleError) {
			const status =
				error.code === 'RULE_NOT_FOUND' ? 404 : error.code === 'RULE_LIMIT_REACHED' ? 409 : 400;
			return failure(
				status,
				error.code,
				status === 404
					? 'Rule not found.'
					: status === 409
						? 'Active rule limit reached.'
						: 'Invalid request.'
			);
		}
		// Shared cursor parser uses the incident service error; expose only its known invalid-input code.
		if (error instanceof Error && 'code' in error && error.code === 'INVALID_INPUT')
			return failure(400, 'INVALID_INPUT', 'Invalid request.');
		return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
	}
}
