import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolvePrincipal } from '$lib/server/auth/principal';
import type { AuthTransaction } from '$lib/server/auth/instance';
import {
	actorAuthorizationFailure,
	failure,
	success,
	onlyKeys,
	requireCapability,
	uuid,
	withActorAuthorization
} from '../roles/http';
import { AutomationRuleError } from '$lib/automation/rules';
import * as rules from '$lib/server/services/automation-rules';
import { logUnexpectedError } from '$lib/server/logging/logger';
import { withAudit } from '$lib/server/services/audit-events';
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
		const principal = await resolvePrincipal(event.request.headers);
		if (!principal) return failure(401, 'UNAUTHORIZED', 'Authentication required.');
		// 5.4W-A (H1): authority re-validated inside the mutation transaction, after the
		// organization lock that rule changes take (FOR UPDATE).
		const authorized = <T>(run: (tx: AuthTransaction) => Promise<T>) =>
			withActorAuthorization(
				db,
				{
					userId: principal.userId,
					organizationId: org,
					permissionIds: ['automations:manage'],
					lock: 'update'
				},
				(tx) => run(tx)
			);
		if (op === 'disable') {
			await authorized((tx) =>
				withAudit(
					tx,
					org,
					principal.userId,
					() => rules.updateAutomationRule(tx, org, id!, { active: false }),
					() => ({
						action: 'automation_rule.deactivated',
						entityType: 'automation_rule',
						entityId: id!
					})
				)
			);
			return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
		}
		const input = await body(event.request);
		if (!input) return failure(400, 'INVALID_INPUT', 'Invalid request.');
		if (op === 'patch')
			return success({
				rule: await authorized((tx) =>
					withAudit(
						tx,
						org,
						principal.userId,
						() => rules.updateAutomationRule(tx, org, id!, input),
						(updated) => ({
							action: 'automation_rule.updated',
							entityType: 'automation_rule',
							entityId: updated.id,
							metadata: {
								fields: Object.keys(input).filter((key) => /^[a-zA-Z]{1,40}$/.test(key)),
								active: updated.active,
								eventType: updated.eventType
							}
						})
					)
				)
			});
		return success(
			{
				rule: await authorized((tx) =>
					withAudit(
						tx,
						org,
						principal.userId,
						() => rules.createAutomationRule(tx, org, principal.userId, input),
						(created) => ({
							action: 'automation_rule.created',
							entityType: 'automation_rule',
							entityId: created.id,
							metadata: { eventType: created.eventType, active: created.active }
						})
					)
				)
			},
			201
		);
	} catch (error) {
		const revoked = actorAuthorizationFailure(error);
		if (revoked) return revoked;
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
		logUnexpectedError(error);
		return failure(500, 'INTERNAL_ERROR', 'Internal server error.');
	}
}
