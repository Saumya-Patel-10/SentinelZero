import { SenderError } from 'spacetimedb/server';
import { fail, newId, type Ctx } from '../security/context';
import { activeServicePrincipal, canInOrg } from '../security/membership';
import { LIMITS } from '../../../shared/src/limits';

type RunRow = NonNullable<ReturnType<Ctx['db']['agentRun']['id']['find']>>;

/**
 * Authorizes a service-principal call against one agent run. All AI reads/writes are bound to a
 * run that (a) a human with REQUEST_AGENT_RUN created, (b) this principal claimed, (c) is RUNNING
 * within its lease, and (d) whose requester STILL holds REQUEST_AGENT_RUN (revocation cuts AI access).
 */
export function requireServiceRun(ctx: Ctx, runId: string): RunRow {
  const run = ctx.db.agentRun.id.find(runId);
  if (!run) fail('NOT_FOUND', 'agent run not found');
  if (!activeServicePrincipal(ctx.db, run.organizationId, ctx.sender)) fail('ACCESS_DENIED', 'not a service principal for this organization');
  if (run.status !== 'RUNNING') fail('INVALID_TRANSITION', `agent run is ${run.status}`);
  if (!run.claimedBy || !run.claimedBy.isEqual(ctx.sender)) fail('ACCESS_DENIED', 'agent run is claimed by another principal');
  if (run.leaseExpiresAt && ctx.timestamp.microsSinceUnixEpoch > run.leaseExpiresAt.microsSinceUnixEpoch) {
    fail('ACCESS_DENIED', 'agent run lease expired');
  }
  if (!canInOrg(ctx.db, run.organizationId, run.requestedBy, 'REQUEST_AGENT_RUN')) {
    fail('ACCESS_DENIED', 'requesting user no longer has access');
  }
  if (!ctx.db.incident.id.find(run.incidentId)) fail('INCIDENT_NOT_FOUND', 'incident not found');
  return run;
}

const clip = (s: string) => (s.length > LIMITS.TOOL_SUMMARY.max ? s.slice(0, LIMITS.TOOL_SUMMARY.max) : s);

export function recordToolCall(ctx: Ctx, run: RunRow, toolName: string, inputSummary: string, outputSummary: string, status: 'OK' | 'ERROR'): void {
  ctx.db.agentToolCall.insert({
    id: newId(ctx),
    organizationId: run.organizationId,
    incidentId: run.incidentId,
    agentRunId: run.id,
    toolName,
    inputSummary: clip(inputSummary),
    outputSummary: clip(outputSummary),
    status,
    timestamp: ctx.timestamp,
  });
}

/**
 * Runs a procedure body in a transaction and converts typed denials into `{ err }` results.
 * Throwing out of a procedure is reported by the 2.14.1 host as a fatal module error (HTTP 500),
 * so expected failures are returned as values instead. The transaction is still rolled back.
 */
export function guardedTx<T>(ctx: { withTx<R>(body: (tx: Ctx) => R): R }, body: (tx: Ctx) => T): { ok: T } | { err: string } {
  try {
    return { ok: ctx.withTx(body) };
  } catch (e) {
    if (e instanceof SenderError) return { err: e.message };
    throw e;
  }
}

export const iso = (ts: { toISOString(): string } | undefined) => (ts ? ts.toISOString() : '');
