import { afterAll, describe, expect, it } from 'vitest';
import { Identity } from 'spacetimedb';
import { DbConnection } from '../../bindings';
import { dbName, disconnectAll, expectCode, httpCall, httpSql, key, stdbUri, subscribe, waitFor, type Actor } from './client';
import { ALL_VIEWS, createTeam, newIncident, SHA, subscribeAll } from './fixtures';
import { decodePositional, decodeResult } from '../../../shared/src/agentContracts';
import { parseBackendError } from '../../../shared/src/errors';
import { verifyAuditChain } from '../../../shared/src/auditChain';

// One test per item of the required negative-security list (docs/SECURITY_MODEL.md, "Verified controls").

afterAll(() => disconnectAll());

const VIEWS_WITH_TENANT_DATA = ALL_VIEWS.filter(v => v !== 'backend_info');
const subscribeEverything = (a: Actor) => subscribe(a, VIEWS_WITH_TENANT_DATA.map(v => `SELECT * FROM ${v}`));

/** Every per-sender view as camelCase accessors, for "sees nothing" assertions. */
function rowCounts(a: Actor): Record<string, number> {
  const db = a.conn.db as unknown as Record<string, { iter(): Iterable<unknown> }>;
  const out: Record<string, number> = {};
  for (const v of VIEWS_WITH_TENANT_DATA) {
    const accessor = v.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
    out[v] = [...db[accessor].iter()].length;
  }
  return out;
}

/** Connects WITHOUT a token: the host assigns a fresh anonymous identity. */
function connectAnonymous(): Promise<Actor> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(stdbUri())
      .withDatabaseName(dbName())
      .onConnect((conn, identity, token) => resolve({ name: 'anonymous', identity, token, conn }))
      .onConnectError((_c, err) => reject(err))
      .build();
  });
}

async function svc(token: string, fn: string, args: unknown[] | Record<string, unknown>) {
  const r = await httpCall(token, fn, args as unknown[]);
  if (r.status === 530) return { code: parseBackendError(r.body).code, json: undefined as unknown };
  if (r.status !== 200) throw new Error(`${fn}: HTTP ${r.status}`);
  let json: unknown = r.body ? JSON.parse(r.body) : undefined;
  if (fn.startsWith('agent_get_')) {
    const res = decodeResult(json);
    if (!res.ok) return { code: parseBackendError(res.error).code, json: undefined };
    json = res.value;
  }
  return { code: undefined, json };
}

/** A team with an incident, one evidence reference, a registered AI principal and a claimed run. */
async function aiFixture(label: string) {
  const team = await createTeam(label);
  for (const a of [team.owner, team.commander, team.analyst, team.responder, team.observer]) await subscribeEverything(a);
  const inc = await newIncident(team.analyst, team.orgId);
  await team.analyst.conn.reducers.appendEvidenceReference({ incidentId: inc.id, evidenceType: 'RANSOM_NOTE', source: 'EXERCISE host-7', sha256: SHA('beef'), classification: 'RESTRICTED', description: 'synthetic ransom note' });
  const ev = await waitFor('evidence', () => [...team.analyst.conn.db.myEvidence.iter()].find(e => e.incidentId === inc.id));
  const sp = (await (await fetch(`${stdbUri()}/v1/identity`, { method: 'POST' })).json()) as { identity: string; token: string };
  await team.owner.conn.reducers.registerServicePrincipal({ organizationId: team.orgId, identity: Identity.fromString(sp.identity), label: 'ai' });
  await team.analyst.conn.reducers.requestAgentRun({ incidentId: inc.id, analysisType: 'response', idempotencyKey: key('run') });
  const run = await waitFor('run', () => [...team.analyst.conn.db.myAgentRuns.iter()].find(r => r.incidentId === inc.id));
  expect((await svc(sp.token, 'agent_claim_run', [run.id, 'test-model', 'FIXTURE'])).code).toBeUndefined();
  return { team, inc, ev, sp, run };
}

async function proposal(f: Awaited<ReturnType<typeof aiFixture>>) {
  const r = await svc(f.sp.token, 'agent_submit_recommendation', [f.run.id, key('rec'), 'Isolate host-7 from ward VLAN', 'EXERCISE', 'P1', 'Ransom note recovered from host-7', [f.ev.id], []]);
  expect(r.code).toBeUndefined();
  return waitFor('recommendation', () => [...f.team.commander.conn.db.myRecommendations.iter()].find(x => x.agentRunId === f.run.id && x.status === 'PENDING'));
}

describe('negative security', () => {
  it('anonymous access: a token-less session sees no tenant rows and cannot mutate', async () => {
    const team = await createTeam('neg-anon');
    await subscribeAll(team.commander);
    const inc = await newIncident(team.commander, team.orgId);
    const anon = await connectAnonymous();
    await subscribeEverything(anon);
    expect(Object.values(rowCounts(anon)).every(n => n === 0), JSON.stringify(rowCounts(anon))).toBe(true);
    await expectCode(anon.conn.reducers.sendMessage({ incidentId: inc.id, content: 'hello', clientMessageId: key() }), 'INCIDENT_NOT_FOUND');
    await expectCode(anon.conn.reducers.createIncident({ organizationId: team.orgId, title: 'Anon incident', description: '', category: 'OTHER', severity: 'LOW', detectedAt: undefined, idempotencyKey: key() }), 'ACCESS_DENIED');
    await expectCode(anon.conn.reducers.inviteMember({ organizationId: team.orgId, userIdentity: anon.identity, role: 'OWNER' }), 'ACCESS_DENIED');
    for (const v of ['my_incidents', 'my_evidence', 'my_messages', 'my_audit_events']) {
      expect(JSON.parse((await httpSql(null, `SELECT * FROM ${v}`)).body)[0].rows, v).toHaveLength(0);
    }
    expect((await httpSql(null, 'SELECT * FROM incident')).status).toBeGreaterThanOrEqual(400);
  });

  it('cross-tenant reads: another organization sees none of tenant A, by any path', async () => {
    const a = await aiFixture('neg-xt-a');
    const b = await createTeam('neg-xt-b');
    await a.team.commander.conn.reducers.sendMessage({ incidentId: a.inc.id, content: 'tenant A only', clientMessageId: key() });
    for (const actor of [b.owner, b.commander, b.analyst]) {
      await subscribeEverything(actor);
      const db = actor.conn.db;
      const leaks = [
        ...[...db.myIncidents.iter()].filter(r => r.organizationId === a.team.orgId),
        ...[...db.myIncidentSummaries.iter()].filter(r => r.organizationId === a.team.orgId),
        ...[...db.myEvidence.iter()].filter(r => r.organizationId === a.team.orgId),
        ...[...db.myMessages.iter()].filter(r => r.organizationId === a.team.orgId),
        ...[...db.myAgentRuns.iter()].filter(r => r.organizationId === a.team.orgId),
        ...[...db.myAuditEvents.iter()].filter(r => r.organizationId === a.team.orgId),
        ...[...db.myIncidentTimeline.iter()].filter(r => r.organizationId === a.team.orgId),
        ...[...db.myAuditChainHeads.iter()].filter(r => r.organizationId === a.team.orgId),
        ...[...db.orgMemberDirectory.iter()].filter(r => r.organizationId === a.team.orgId),
      ];
      expect(leaks, actor.name).toHaveLength(0);
    }
    // The AI handshake does not disclose another tenant's run either.
    const access = decodePositional('RunAccess', (await svc(b.commander.token, 'verify_agent_run_access', [a.run.id])).json);
    expect(access).toMatchObject({ authorized: false, incidentId: '', organizationId: '' });
    const sql = await httpSql(b.owner.token, `SELECT * FROM my_incidents WHERE id = '${a.inc.id}'`);
    expect(JSON.parse(sql.body)[0].rows).toHaveLength(0);
  });

  it('role escalation: no role can grant itself or others more power than its capability allows', async () => {
    const team = await createTeam('neg-escalation');
    await subscribeAll(team.commander);
    const inc = await newIncident(team.commander, team.orgId);
    const outsiderId = (await (await fetch(`${stdbUri()}/v1/identity`, { method: 'POST' })).json()).identity as string;
    for (const actor of [team.commander, team.analyst, team.responder, team.observer]) {
      const r = actor.conn.reducers;
      await expectCode(r.inviteMember({ organizationId: team.orgId, userIdentity: actor.identity, role: 'OWNER' }), 'ACCESS_DENIED');
      await expectCode(r.revokeMember({ membershipId: team.membershipIdOf(team.owner), reason: 'take over the org' }), 'ACCESS_DENIED');
      await expectCode(r.registerServicePrincipal({ organizationId: team.orgId, identity: Identity.fromString(outsiderId), label: 'rogue' }), 'ACCESS_DENIED');
      await expectCode(r.createOrganization({ name: 'Rogue org', dataClass: 'LIVE' }), 'ACCESS_DENIED');
      await expectCode(r.addTrustedIssuer({ issuer: 'https://evil.example' }), 'ACCESS_DENIED');
      await expectCode(r.setUserDisabled({ userIdentity: team.owner.identity, disabled: true }), 'ACCESS_DENIED');
    }
    // Analysts can create incidents but not drive the lifecycle or reopen.
    await subscribeAll(team.analyst);
    await expectCode(team.analyst.conn.reducers.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: 1, toStatus: 'TRIAGING', reason: 'escalate myself', evidenceId: '' }), 'ACCESS_DENIED');
    await expectCode(team.analyst.conn.reducers.assignIncidentCommander({ incidentId: inc.id, expectedVersion: 1, commanderIdentity: team.analyst.identity }), 'ACCESS_DENIED');
    // An active member cannot be "re-invited" with a higher role; changing roles means revoke + invite (both audited).
    await expectCode(team.owner.conn.reducers.inviteMember({ organizationId: team.orgId, userIdentity: team.analyst.identity, role: 'OWNER' }), 'VALIDATION_FAILED');
    // A human member cannot become a service principal (and vice versa, see agentAccess.test.ts).
    await expectCode(team.owner.conn.reducers.registerServicePrincipal({ organizationId: team.orgId, identity: team.analyst.identity, label: 'x' }), 'VALIDATION_FAILED');
    // Assigning a commander requires the target to actually hold COMMANDER.
    await expectCode(team.commander.conn.reducers.assignIncidentCommander({ incidentId: inc.id, expectedVersion: 1, commanderIdentity: team.analyst.identity }), 'VALIDATION_FAILED');
  });

  it('revoked member: an open session loses approval power and its views immediately', async () => {
    const f = await aiFixture('neg-revoked');
    const rec = await proposal(f);
    await f.team.commander.conn.reducers.createTask({ incidentId: f.inc.id, title: 'Rotate domain admin credentials', description: '', priority: 'P1', assignedIdentity: undefined, requiresApproval: true, idempotencyKey: key() });
    const task = await waitFor('task', () => [...f.team.commander.conn.db.myTasks.iter()].find(t => t.incidentId === f.inc.id));
    await f.team.owner.conn.reducers.revokeMember({ membershipId: f.team.membershipIdOf(f.team.commander), reason: 'commander device compromised' });
    await waitFor('commander views emptied', () => [...f.team.commander.conn.db.myRecommendations.iter()].length === 0);
    await expectCode(f.team.commander.conn.reducers.approveRecommendation({ recommendationId: rec.id, assignedIdentity: undefined, reason: '' }), 'INCIDENT_NOT_FOUND');
    await expectCode(f.team.commander.conn.reducers.approveTask({ taskId: task.id, reason: '' }), 'INCIDENT_NOT_FOUND');
    expect(rowCounts(f.team.commander)).toMatchObject({ my_incidents: 0, my_tasks: 0, my_evidence: 0, my_incident_timeline: 0, my_audit_chain_heads: 0 });
    // Nothing was approved on the revoked member's behalf.
    const still = [...f.team.owner.conn.db.myRecommendations.iter()].find(r => r.id === rec.id);
    expect(still?.status).toBe('PENDING');
  });

  it('stale status version: every versioned write rejects a stale expectedVersion and leaves the row unchanged', async () => {
    const team = await createTeam('neg-stale');
    await subscribeAll(team.commander);
    const c = team.commander.conn.reducers;
    const db = team.commander.conn.db;
    const inc = await newIncident(team.commander, team.orgId);
    await c.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: 1, toStatus: 'TRIAGING', reason: 'start triage', evidenceId: '' });
    await expectCode(c.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: 1, toStatus: 'INVESTIGATING', reason: 'second tab', evidenceId: '' }), 'VERSION_CONFLICT');
    await expectCode(c.updateIncident({ incidentId: inc.id, expectedVersion: 1, title: 'Stale edit', description: '', category: 'OTHER', severity: 'LOW' }), 'VERSION_CONFLICT');
    await expectCode(c.assignIncidentCommander({ incidentId: inc.id, expectedVersion: 1, commanderIdentity: team.commander.identity }), 'VERSION_CONFLICT');

    await c.addAsset({ incidentId: inc.id, name: 'ehr-db01', assetType: 'DATABASE', criticality: 'CRITICAL', compromiseStatus: 'SUSPECTED', availabilityStatus: 'DEGRADED', description: '' });
    await c.addService({ incidentId: inc.id, name: 'EHR', description: '', criticality: 'CRITICAL', availabilityStatus: 'DEGRADED', availabilityVerification: 'SUSPECTED' });
    const asset = await waitFor('asset', () => [...db.myAssets.iter()].find(a => a.incidentId === inc.id));
    const svcRow = await waitFor('service', () => [...db.myServices.iter()].find(s => s.incidentId === inc.id));
    await c.addOperationalImpact({ incidentId: inc.id, serviceId: svcRow.id, impactType: 'SERVICE_DEGRADATION', severity: 'HIGH', verification: 'SUSPECTED', affectedGroup: 'Clinicians', description: '' });
    const impact = await waitFor('impact', () => [...db.myOperationalImpacts.iter()].find(i => i.incidentId === inc.id));
    await c.createTask({ incidentId: inc.id, title: 'Image ehr-db01', description: '', priority: 'P1', assignedIdentity: undefined, requiresApproval: false, idempotencyKey: key() });
    const task = await waitFor('task', () => [...db.myTasks.iter()].find(t => t.incidentId === inc.id));

    await c.updateAssetStatus({ assetId: asset.id, expectedVersion: 1, compromiseStatus: 'CONFIRMED', availabilityStatus: 'UNAVAILABLE', verifiedNow: true, reason: 'EDR confirmed' });
    await expectCode(c.updateAssetStatus({ assetId: asset.id, expectedVersion: 1, compromiseStatus: 'UNKNOWN', availabilityStatus: 'AVAILABLE', verifiedNow: false, reason: 'stale view' }), 'VERSION_CONFLICT');
    await c.updateServiceStatus({ serviceId: svcRow.id, expectedVersion: 1, availabilityStatus: 'UNAVAILABLE', availabilityVerification: 'CONFIRMED', reason: 'outage confirmed' });
    await expectCode(c.updateServiceStatus({ serviceId: svcRow.id, expectedVersion: 1, availabilityStatus: 'AVAILABLE', availabilityVerification: 'CONFIRMED', reason: 'stale view' }), 'VERSION_CONFLICT');
    await c.updateOperationalImpact({ impactId: impact.id, expectedVersion: 1, severity: 'CRITICAL', verification: 'CONFIRMED', description: 'confirmed' });
    await expectCode(c.updateOperationalImpact({ impactId: impact.id, expectedVersion: 1, severity: 'LOW', verification: 'RULED_OUT', description: 'stale' }), 'VERSION_CONFLICT');
    await c.updateTaskStatus({ taskId: task.id, expectedVersion: 1, toStatus: 'IN_PROGRESS', note: '' });
    await expectCode(c.updateTaskStatus({ taskId: task.id, expectedVersion: 1, toStatus: 'CANCELLED', note: 'stale' }), 'VERSION_CONFLICT');
    await expectCode(c.assignTask({ taskId: task.id, expectedVersion: 1, assignedIdentity: team.responder.identity }), 'VERSION_CONFLICT');

    await waitFor('final state', () => {
      const i = [...db.myIncidents.iter()].find(x => x.id === inc.id);
      const a = [...db.myAssets.iter()].find(x => x.id === asset.id);
      const t = [...db.myTasks.iter()].find(x => x.id === task.id);
      return i?.status === 'TRIAGING' && i.version === 2 && a?.compromiseStatus === 'CONFIRMED' && a.version === 2 && t?.status === 'IN_PROGRESS' && t.version === 2;
    });
  });

  it('duplicate approval: concurrent approvals by different approvers create exactly one task', async () => {
    const f = await aiFixture('neg-dup');
    const rec = await proposal(f);
    await Promise.all([
      f.team.commander.conn.reducers.approveRecommendation({ recommendationId: rec.id, assignedIdentity: undefined, reason: 'commander approves' }),
      f.team.owner.conn.reducers.approveRecommendation({ recommendationId: rec.id, assignedIdentity: undefined, reason: 'owner approves' }),
      f.team.commander.conn.reducers.approveRecommendation({ recommendationId: rec.id, assignedIdentity: undefined, reason: 'double click' }),
    ]);
    await waitFor('approved', () => [...f.team.owner.conn.db.myRecommendations.iter()].find(r => r.id === rec.id && r.status === 'APPROVED'));
    await new Promise(r => setTimeout(r, 200));
    const tasks = [...f.team.owner.conn.db.myTasks.iter()].filter(t => t.sourceRecommendationId === rec.id);
    expect(tasks).toHaveLength(1);
    const decided = [...f.team.owner.conn.db.myRecommendations.iter()].find(r => r.id === rec.id)!;
    expect(decided.createdTaskId).toBe(tasks[0].id);
    const approvals = [...f.team.owner.conn.db.myAuditEvents.iter()].filter(e => e.eventType === 'RECOMMENDATION_APPROVED' && e.targetId === rec.id);
    expect(approvals).toHaveLength(1);
    await expectCode(f.team.owner.conn.reducers.rejectRecommendation({ recommendationId: rec.id, reason: 'contradictory decision' }), 'INVALID_TRANSITION');
    // The AI cannot decide; a responder cannot decide.
    expect((await svc(f.sp.token, 'approve_recommendation', { recommendationId: rec.id, assignedIdentity: { none: [] }, reason: '' })).code).toBe('INCIDENT_NOT_FOUND');
    await expectCode(f.team.responder.conn.reducers.rejectRecommendation({ recommendationId: rec.id, reason: 'not my call' }), 'ACCESS_DENIED');
  });

  it('unauthorized evidence access: evidence is invisible outside O/C/A of its incident and cannot be cited elsewhere', async () => {
    const f = await aiFixture('neg-evidence');
    const other = await aiFixture('neg-evidence-b');
    for (const actor of [f.team.responder, f.team.observer, other.team.owner, other.team.commander, other.team.analyst]) {
      expect([...actor.conn.db.myEvidence.iter()].filter(e => e.id === f.ev.id), actor.name).toHaveLength(0);
      const sql = await httpSql(actor.token, `SELECT * FROM my_evidence WHERE id = '${f.ev.id}'`);
      expect(JSON.parse(sql.body)[0].rows, actor.name).toHaveLength(0);
    }
    expect((await httpSql(f.team.analyst.token, 'SELECT * FROM evidence_reference')).status).toBeGreaterThanOrEqual(400);
    // Another tenant's AI principal cannot read this incident's evidence.
    expect((await svc(other.sp.token, 'agent_get_evidence_summaries', [f.run.id])).code).toBe('ACCESS_DENIED');
    // Evidence IDs from another incident are rejected wherever evidence can be cited.
    const inc2 = await newIncident(f.team.commander, f.team.orgId);
    await expectCode(f.team.commander.conn.reducers.transitionIncidentStatus({ incidentId: inc2.id, expectedVersion: 1, toStatus: 'TRIAGING', reason: 'cite foreign evidence', evidenceId: f.ev.id }), 'VALIDATION_FAILED');
    expect((await svc(other.sp.token, 'agent_submit_recommendation', [other.run.id, key(), 'Cite foreign evidence', '', 'P2', 'evidence from another org', [f.ev.id], []])).code).toBe('VALIDATION_FAILED');
    await f.team.analyst.conn.reducers.addAsset({ incidentId: inc2.id, name: 'host-9', assetType: 'SERVER', criticality: 'LOW', compromiseStatus: 'UNKNOWN', availabilityStatus: 'UNKNOWN', description: '' });
    const host9 = await waitFor('asset', () => [...f.team.analyst.conn.db.myAssets.iter()].find(a => a.incidentId === inc2.id));
    await expectCode(f.team.analyst.conn.reducers.updateDataScope({ incidentId: inc2.id, assetId: host9.id, dataCategory: 'Payroll', sensitivity: 'CONFIDENTIAL', lockStatus: 'UNKNOWN', exfiltrationStatus: 'UNKNOWN', integrityStatus: 'UNKNOWN', estimatedRecords: undefined, confidence: 'LOW', evidenceId: f.ev.id }), 'VALIDATION_FAILED');
  });

  it('timeline and audit chain views follow the role matrix, and the live chain verifies', async () => {
    const team = await createTeam('neg-audit');
    for (const a of [team.commander, team.responder, team.observer]) await subscribeEverything(a);
    const inc = await newIncident(team.commander, team.orgId);
    await team.commander.conn.reducers.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: 1, toStatus: 'TRIAGING', reason: 'confidential reason text', evidenceId: '' });
    const timeline = await waitFor('responder timeline', () => {
      const rows = [...team.responder.conn.db.myIncidentTimeline.iter()].filter(e => e.incidentId === inc.id);
      return rows.length >= 2 ? rows : undefined;
    });
    expect(timeline.map(e => e.eventType)).toEqual(expect.arrayContaining(['INCIDENT_CREATED', 'INCIDENT_STATUS_CHANGED']));
    expect(Object.keys(timeline[0])).not.toContain('metadata');
    expect([...team.responder.conn.db.myAuditEvents.iter()]).toHaveLength(0);
    expect([...team.responder.conn.db.myAuditChainHeads.iter()]).toHaveLength(0);
    expect([...team.observer.conn.db.myIncidentTimeline.iter()]).toHaveLength(0);

    const db = team.commander.conn.db;
    const head = await waitFor('head', () => [...db.myAuditChainHeads.iter()].find(h => h.organizationId === team.orgId));
    const result = verifyAuditChain(team.orgId, db.myAuditEvents.iter(), { head });
    expect(result).toMatchObject({ status: 'VERIFIED', headChecked: true, lastSeq: head.seq, lastHash: head.lastHash });
    expect(result.checkedCount).toBe(Number(head.seq));
    // A later verification against the earlier pin still succeeds as the chain grows.
    await team.commander.conn.reducers.sendMessage({ incidentId: inc.id, content: 'after pin', clientMessageId: key() });
    const head2 = await waitFor('head advanced', () => [...db.myAuditChainHeads.iter()].find(h => h.organizationId === team.orgId && h.seq > head.seq));
    expect(verifyAuditChain(team.orgId, db.myAuditEvents.iter(), { head: head2, pin: { seq: result.lastSeq, hash: result.lastHash } }).status).toBe('VERIFIED');
  });
});
