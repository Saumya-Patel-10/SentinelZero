import { afterAll, describe, expect, it } from 'vitest';
import { Identity } from 'spacetimedb';
import { disconnectAll, expectCode, httpCall, key, stdbUri, waitFor } from './client';
import { createTeam, newIncident, SHA, subscribeAll } from './fixtures';
import { decodeResult } from '../../../shared/src/agentContracts';
import { parseBackendError } from '../../../shared/src/errors';
import { RATE_LIMITS } from '../../../shared/src/limits';

// Regression tests for gaps found in the backend security review (docs/SECURITY_MODEL.md, section 3.1).

afterAll(() => disconnectAll());

async function mint() {
  return (await (await fetch(`${stdbUri()}/v1/identity`, { method: 'POST' })).json()) as { identity: string; token: string };
}

/** HTTP call as the AI service makes it; returns the typed error code, or undefined on success. */
async function svc(token: string, fn: string, args: unknown[]): Promise<string | undefined> {
  const r = await httpCall(token, fn, args);
  if (r.status === 530) return parseBackendError(r.body).code;
  if (r.status !== 200) throw new Error(`${fn}: HTTP ${r.status}`);
  if (fn.startsWith('agent_get_')) {
    const res = decodeResult(JSON.parse(r.body));
    return res.ok ? undefined : parseBackendError(res.error).code;
  }
  return undefined;
}

async function codesOf(calls: Promise<unknown>[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const r of await Promise.allSettled(calls)) {
    let code = r.status === 'fulfilled' ? (r.value === undefined ? 'OK' : String(r.value)) : parseBackendError(String((r.reason as Error).message)).code;
    if (code === 'UNKNOWN' && r.status === 'rejected') code = `UNKNOWN(${String((r.reason as Error).message).slice(0, 200)})`;
    out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}

describe('backend hardening', () => {
  it('a CLOSED incident and all its children are read-only for humans and the AI', async () => {
    const team = await createTeam('closed');
    for (const a of [team.owner, team.commander, team.analyst]) await subscribeAll(a);
    const c = team.commander.conn.reducers;
    const inc = await newIncident(team.commander, team.orgId);

    await team.analyst.conn.reducers.appendEvidenceReference({ incidentId: inc.id, evidenceType: 'LOG_EXPORT', source: 'EXERCISE siem', sha256: SHA('c105ed'), classification: 'CONFIDENTIAL', description: '' });
    const ev = await waitFor('evidence', () => [...team.analyst.conn.db.myEvidence.iter()].find(e => e.incidentId === inc.id));
    const sp = await mint();
    await team.owner.conn.reducers.registerServicePrincipal({ organizationId: team.orgId, identity: Identity.fromString(sp.identity), label: 'ai' });
    await team.analyst.conn.reducers.requestAgentRun({ incidentId: inc.id, analysisType: 'response', idempotencyKey: key('run1') });
    const run1 = await waitFor('run1', () => [...team.analyst.conn.db.myAgentRuns.iter()].find(r => r.incidentId === inc.id));
    expect(await svc(sp.token, 'agent_claim_run', [run1.id, 'm', 'FIXTURE'])).toBeUndefined();
    expect(await svc(sp.token, 'agent_submit_recommendation', [run1.id, key('rec'), 'Isolate host-3', '', 'P1', 'Evidence of encryption', [ev.id], []])).toBeUndefined();
    const rec = await waitFor('rec', () => [...team.commander.conn.db.myRecommendations.iter()].find(r => r.agentRunId === run1.id));
    await team.analyst.conn.reducers.requestAgentRun({ incidentId: inc.id, analysisType: 'impact', idempotencyKey: key('run2') });
    const run2 = await waitFor('run2', () => [...team.analyst.conn.db.myAgentRuns.iter()].find(r => r.incidentId === inc.id && r.id !== run1.id));

    await c.createTask({ incidentId: inc.id, title: 'Needs approval', description: '', priority: 'P1', assignedIdentity: undefined, requiresApproval: true, idempotencyKey: key() });
    await c.createTask({ incidentId: inc.id, title: 'Open work item', description: '', priority: 'P2', assignedIdentity: team.responder.identity, requiresApproval: false, idempotencyKey: key() });
    const gated = await waitFor('gated', () => [...team.commander.conn.db.myTasks.iter()].find(t => t.title === 'Needs approval'));
    const open = await waitFor('open', () => [...team.commander.conn.db.myTasks.iter()].find(t => t.title === 'Open work item'));

    await c.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: 1, toStatus: 'CLOSED', reason: 'false positive', evidenceId: '' });
    await waitFor('closed', () => [...team.commander.conn.db.myIncidents.iter()].find(i => i.id === inc.id && i.status === 'CLOSED'));

    await expectCode(c.assignIncidentCommander({ incidentId: inc.id, expectedVersion: 2, commanderIdentity: team.commander.identity }), 'INVALID_TRANSITION');
    await expectCode(c.assignTask({ taskId: open.id, expectedVersion: 1, assignedIdentity: team.analyst.identity }), 'INVALID_TRANSITION');
    await expectCode(c.updateTaskStatus({ taskId: open.id, expectedVersion: 1, toStatus: 'IN_PROGRESS', note: '' }), 'INVALID_TRANSITION');
    await expectCode(team.responder.conn.reducers.updateTaskStatus({ taskId: open.id, expectedVersion: 1, toStatus: 'IN_PROGRESS', note: '' }), 'INVALID_TRANSITION');
    await expectCode(c.approveTask({ taskId: gated.id, reason: '' }), 'INVALID_TRANSITION');
    await expectCode(c.rejectTask({ taskId: gated.id, reason: 'not needed' }), 'INVALID_TRANSITION');
    await expectCode(c.sendMessage({ incidentId: inc.id, content: 'after close', clientMessageId: key() }), 'INVALID_TRANSITION');
    await expectCode(team.analyst.conn.reducers.requestAgentRun({ incidentId: inc.id, analysisType: 'intake', idempotencyKey: key() }), 'INVALID_TRANSITION');
    await expectCode(c.approveRecommendation({ recommendationId: rec.id, assignedIdentity: undefined, reason: '' }), 'INVALID_TRANSITION');
    await expectCode(c.rejectRecommendation({ recommendationId: rec.id, reason: 'incident closed' }), 'INVALID_TRANSITION');
    expect(await svc(sp.token, 'agent_claim_run', [run2.id, 'm', 'FIXTURE'])).toBe('INVALID_TRANSITION');
    expect(await svc(sp.token, 'agent_submit_recommendation', [run1.id, key('rec'), 'Late proposal', '', 'P2', 'Arrived after closure', [], ['unknown']])).toBe('INVALID_TRANSITION');

    // Winding down is still allowed: the AI can finish its run and a human can cancel a pending one.
    expect(await svc(sp.token, 'agent_complete_run', [run1.id, 'COMPLETED', 'NONE', 'closed'])).toBeUndefined();
    await team.analyst.conn.reducers.cancelAgentRun({ runId: run2.id, reason: 'incident closed' });

    // Nothing changed while closed.
    const tasks = [...team.commander.conn.db.myTasks.iter()].filter(t => t.incidentId === inc.id);
    expect(tasks.map(t => [t.title, t.status, t.version]).sort()).toEqual([
      ['Needs approval', 'AWAITING_APPROVAL', 1],
      ['Open work item', 'PENDING', 1],
    ]);
    expect([...team.commander.conn.db.myRecommendations.iter()].filter(r => r.incidentId === inc.id).map(r => r.status)).toEqual(['PENDING']);

    // After a COMMANDER reopens, writes work again.
    await c.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: 2, toStatus: 'INVESTIGATING', reason: 'New indicators found on ward hosts', evidenceId: '' });
    await c.approveTask({ taskId: gated.id, reason: 'reopened' });
    await c.sendMessage({ incidentId: inc.id, content: 'reopened', clientMessageId: key() });
  });

  it('concurrent writes never collide on server-generated ids', async () => {
    const team = await createTeam('concurrent-ids');
    await subscribeAll(team.commander);
    const inc = await newIncident(team.commander, team.orgId);
    // Parallel HTTP calls from several identities often share a host timestamp.
    const actors = [team.owner, team.commander, team.analyst];
    const calls = actors.flatMap(a => [
      ...Array.from({ length: 10 }, (_, i) => svc(a.token, 'create_incident', [team.orgId, `Concurrent ${a.name} ${i}`, '', 'OTHER', 'LOW', { none: [] }, key('cc')])),
      ...Array.from({ length: 10 }, (_, i) => svc(a.token, 'add_asset', [inc.id, `cc-${a.name}-${i}`, 'SERVER', 'LOW', 'UNKNOWN', 'UNKNOWN', ''])),
    ]);
    expect(await codesOf(calls)).toEqual({ OK: calls.length });
    const assets = await waitFor('all assets', () => {
      const rows = [...team.commander.conn.db.myAssets.iter()].filter(x => x.incidentId === inc.id);
      return rows.length === 30 ? rows : undefined;
    });
    expect(new Set(assets.map(x => x.id)).size).toBe(30);
  });

  it('rate-limits incident creation and incident writes per identity', async () => {
    const team = await createTeam('flood');
    await subscribeAll(team.commander);
    const a = team.analyst.conn.reducers;
    const createMax = RATE_LIMITS.create_incident.max;
    const creates = await codesOf(
      Array.from({ length: createMax + 3 }, (_, i) =>
        a.createIncident({ organizationId: team.orgId, title: `Flood incident ${i}`, description: '', category: 'OTHER', severity: 'LOW', detectedAt: undefined, idempotencyKey: key('flood') })
      )
    );
    expect(creates).toEqual({ OK: createMax, RATE_LIMITED: 3 });

    const inc = await newIncident(team.commander, team.orgId);
    const writeMax = RATE_LIMITS.incident_write.max;
    const writes = await codesOf(
      Array.from({ length: writeMax + 3 }, (_, i) =>
        a.addAsset({ incidentId: inc.id, name: `host-${i}`, assetType: 'SERVER', criticality: 'LOW', compromiseStatus: 'UNKNOWN', availabilityStatus: 'UNKNOWN', description: '' })
      )
    );
    expect(writes).toEqual({ OK: writeMax, RATE_LIMITED: 3 });
    // The budget is per identity: another analyst-level member is unaffected.
    await team.commander.conn.reducers.addAsset({ incidentId: inc.id, name: 'commander-host', assetType: 'SERVER', criticality: 'LOW', compromiseStatus: 'UNKNOWN', availabilityStatus: 'UNKNOWN', description: '' });
  });

  it('rate-limits service-principal tool calls (each one writes an agent_tool_call row)', async () => {
    const team = await createTeam('tool-flood');
    await subscribeAll(team.analyst);
    const inc = await newIncident(team.analyst, team.orgId);
    const sp = await mint();
    await team.owner.conn.reducers.registerServicePrincipal({ organizationId: team.orgId, identity: Identity.fromString(sp.identity), label: 'ai' });
    await team.analyst.conn.reducers.requestAgentRun({ incidentId: inc.id, analysisType: 'intake', idempotencyKey: key('run') });
    const run = await waitFor('run', () => [...team.analyst.conn.db.myAgentRuns.iter()].find(r => r.incidentId === inc.id));
    expect(await svc(sp.token, 'agent_claim_run', [run.id, 'm', 'FIXTURE'])).toBeUndefined();

    const max = RATE_LIMITS.agent_tool_call.max;
    const results: Record<string, number> = {};
    for (let i = 0; i < max + 3; i += 20) {
      const batch = await codesOf(Array.from({ length: Math.min(20, max + 3 - i) }, () => svc(sp.token, 'agent_get_incident', [run.id])));
      for (const [k, v] of Object.entries(batch)) results[k] = (results[k] ?? 0) + v;
    }
    expect(results).toEqual({ OK: max, RATE_LIMITED: 3 });
    await new Promise(r => setTimeout(r, 200));
    expect([...team.analyst.conn.db.myAgentToolCalls.iter()].filter(t => t.agentRunId === run.id)).toHaveLength(max);
  });

  it('a disabled human member cannot be re-registered as a service principal', async () => {
    const team = await createTeam('sp-disabled');
    await team.admin.conn.reducers.setUserDisabled({ userIdentity: team.analyst.identity, disabled: true });
    await expectCode(
      team.owner.conn.reducers.registerServicePrincipal({ organizationId: team.orgId, identity: team.analyst.identity, label: 'smuggled' }),
      'VALIDATION_FAILED'
    );
    // Re-enabling restores a plain human member, never a dual human + machine identity.
    await team.admin.conn.reducers.setUserDisabled({ userIdentity: team.analyst.identity, disabled: false });
    await subscribeAll(team.owner);
    expect([...team.owner.conn.db.myServicePrincipals.iter()].filter(s => s.organizationId === team.orgId)).toHaveLength(0);
  });

  it('a disabled OWNER does not count toward the last-OWNER guard', async () => {
    const team = await createTeam('owner-disabled');
    const adminMembership = team.membershipIdOf(team.admin);
    const ownerMembership = team.membershipIdOf(team.owner);
    await team.admin.conn.reducers.setUserDisabled({ userIdentity: team.owner.identity, disabled: true });
    await expectCode(team.admin.conn.reducers.revokeMember({ membershipId: adminMembership, reason: 'leaving the org' }), 'VALIDATION_FAILED');
    // Removing the disabled owner is fine: an enabled OWNER remains.
    await team.admin.conn.reducers.revokeMember({ membershipId: ownerMembership, reason: 'device compromised' });
  });

  it('service principals and observers cannot decide, approve or write', async () => {
    const team = await createTeam('no-decide');
    await subscribeAll(team.commander);
    const inc = await newIncident(team.commander, team.orgId);
    await team.commander.conn.reducers.createTask({ incidentId: inc.id, title: 'Gated task', description: '', priority: 'P1', assignedIdentity: undefined, requiresApproval: true, idempotencyKey: key() });
    const task = await waitFor('task', () => [...team.commander.conn.db.myTasks.iter()].find(t => t.incidentId === inc.id));
    const sp = await mint();
    await team.owner.conn.reducers.registerServicePrincipal({ organizationId: team.orgId, identity: Identity.fromString(sp.identity), label: 'ai' });

    expect(await svc(sp.token, 'approve_task', [task.id, ''])).toBe('INCIDENT_NOT_FOUND');
    expect(await svc(sp.token, 'reject_task', [task.id, 'no thanks'])).toBe('INCIDENT_NOT_FOUND');
    expect(await svc(sp.token, 'create_task', [inc.id, 'AI-made task', '', 'P1', { none: [] }, false, key()])).toBe('INCIDENT_NOT_FOUND');
    expect(await svc(sp.token, 'invite_member', [team.orgId, [`0x${sp.identity}`], 'COMMANDER'])).toBe('ACCESS_DENIED');

    const o = team.observer.conn.reducers;
    await expectCode(o.approveTask({ taskId: task.id, reason: '' }), 'ACCESS_DENIED');
    await expectCode(o.rejectTask({ taskId: task.id, reason: 'observer says no' }), 'ACCESS_DENIED');
    await expectCode(o.appendEvidenceReference({ incidentId: inc.id, evidenceType: 'LOG_EXPORT', source: 'x', sha256: SHA('0b5'), classification: 'CONFIDENTIAL', description: '' }), 'ACCESS_DENIED');
    await expectCode(o.updateTaskStatus({ taskId: task.id, expectedVersion: 1, toStatus: 'CANCELLED', note: '' }), 'ACCESS_DENIED');
    await expectCode(o.createIncident({ organizationId: team.orgId, title: 'Observer incident', description: '', category: 'OTHER', severity: 'LOW', detectedAt: undefined, idempotencyKey: key() }), 'ACCESS_DENIED');

    const still = [...team.commander.conn.db.myTasks.iter()].find(t => t.id === task.id);
    expect(still).toMatchObject({ approvalStatus: 'PENDING', status: 'AWAITING_APPROVAL', version: 1 });
  });
});
