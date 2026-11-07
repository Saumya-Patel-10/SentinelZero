import { afterAll, describe, expect, it } from 'vitest';
import { disconnectAll, expectCode, key, waitFor } from './client';
import { createTeam, newIncident, SHA, subscribeAll } from './fixtures';
import { buildImpactGraph } from '../../../shared/src/graph';
import { AUDIT_GENESIS_HASH, computeAuditHash } from '../../src/security/auditHash';

afterAll(() => disconnectAll());

describe('impact graph, data scope and evidence', () => {
  it('propagates graph edits to a second client and enforces per-role visibility', async () => {
    const team = await createTeam('graph');
    for (const a of [team.commander, team.analyst, team.responder, team.observer]) await subscribeAll(a);
    const inc = await newIncident(team.commander, team.orgId);
    const an = team.analyst.conn.reducers;

    await an.addAsset({ incidentId: inc.id, name: 'sched-db01', assetType: 'DATABASE', criticality: 'CRITICAL', compromiseStatus: 'SUSPECTED', availabilityStatus: 'UNAVAILABLE', description: 'EXERCISE' });
    await an.addService({ incidentId: inc.id, name: 'Outpatient scheduling', description: '', criticality: 'HIGH', availabilityStatus: 'UNAVAILABLE', availabilityVerification: 'CONFIRMED' });
    const db = team.commander.conn.db;
    const asset = await waitFor('asset', () => [...db.myAssets.iter()].find(a => a.incidentId === inc.id));
    const svc = await waitFor('service', () => [...db.myServices.iter()].find(s => s.incidentId === inc.id));

    await an.addServiceDependency({ incidentId: inc.id, sourceAssetId: asset.id, targetServiceId: svc.id, dependencyType: 'STORES_DATA_FOR', verification: 'CONFIRMED' });
    await an.addServiceDependency({ incidentId: inc.id, sourceAssetId: asset.id, targetServiceId: svc.id, dependencyType: 'STORES_DATA_FOR', verification: 'CONFIRMED' }); // idempotent
    await an.addOperationalImpact({ incidentId: inc.id, serviceId: svc.id, impactType: 'SERVICE_OUTAGE', severity: 'HIGH', verification: 'CONFIRMED', affectedGroup: 'Outpatients', description: 'Appointments cannot be booked' });
    await an.appendEvidenceReference({ incidentId: inc.id, evidenceType: 'RANSOM_NOTE', source: 'sched-db01:/README_LOCKED.txt', sha256: SHA('abc123'), classification: 'CONFIDENTIAL', description: 'ransom note copy' });
    const ev = await waitFor('evidence', () => [...db.myEvidence.iter()].find(e => e.incidentId === inc.id));
    await an.updateDataScope({ incidentId: inc.id, assetId: asset.id, dataCategory: 'Appointment records', sensitivity: 'REGULATED', lockStatus: 'CONFIRMED', exfiltrationStatus: 'UNKNOWN', integrityStatus: 'SUSPECTED', estimatedRecords: 42000n, confidence: 'MEDIUM', evidenceId: ev.id });
    await an.updateAssetStatus({ assetId: asset.id, expectedVersion: 1, compromiseStatus: 'CONFIRMED', availabilityStatus: 'UNAVAILABLE', verifiedNow: true, reason: 'EDR alert confirmed' });

    await waitFor('commander sees updated asset', () => [...db.myAssets.iter()].find(a => a.id === asset.id && a.compromiseStatus === 'CONFIRMED' && a.lastVerifiedAt));
    await waitFor('impact', () => [...db.myOperationalImpacts.iter()].find(i => i.incidentId === inc.id));
    const scope = await waitFor('scope', () => [...db.myDataScopes.iter()].find(s => s.incidentId === inc.id));
    expect(scope.lockStatus).toBe('CONFIRMED');
    expect(scope.exfiltrationStatus).toBe('UNKNOWN'); // locking does not imply exfiltration
    expect([...db.myServiceDependencies.iter()].filter(d => d.incidentId === inc.id)).toHaveLength(1);

    const graph = buildImpactGraph(inc.id, {
      assets: [...db.myAssets.iter()],
      services: [...db.myServices.iter()],
      dependencies: [...db.myServiceDependencies.iter()],
      impacts: [...db.myOperationalImpacts.iter()],
    });
    expect(graph.nodes.map(n => n.kind).sort()).toEqual(['asset', 'impact_group', 'service']);
    expect(graph.edges.map(e => e.kind).sort()).toEqual(['dependency', 'impact']);

    // Responder: graph yes, sensitive scope/evidence/audit no. Observer: none of it.
    await waitFor('responder graph', () => [...team.responder.conn.db.myAssets.iter()].find(a => a.id === asset.id));
    expect([...team.responder.conn.db.myDataScopes.iter()]).toHaveLength(0);
    expect([...team.responder.conn.db.myEvidence.iter()]).toHaveLength(0);
    expect([...team.responder.conn.db.myAuditEvents.iter()]).toHaveLength(0);
    for (const t of ['myAssets', 'myServices', 'myDataScopes', 'myEvidence', 'myTasks', 'myMessages', 'myAuditEvents'] as const) {
      expect([...team.observer.conn.db[t].iter()], `observer ${t}`).toHaveLength(0);
    }

    // Cross-incident references are rejected.
    const other = await newIncident(team.commander, team.orgId);
    await expectCode(an.addServiceDependency({ incidentId: other.id, sourceAssetId: asset.id, targetServiceId: svc.id, dependencyType: 'HOSTS', verification: 'UNKNOWN' }), 'VALIDATION_FAILED');
    await expectCode(an.updateDataScope({ incidentId: other.id, assetId: asset.id, dataCategory: 'x', sensitivity: 'INTERNAL', lockStatus: 'UNKNOWN', exfiltrationStatus: 'UNKNOWN', integrityStatus: 'UNKNOWN', estimatedRecords: undefined, confidence: 'LOW', evidenceId: '' }), 'VALIDATION_FAILED');
  });
});

describe('tasks and approval', () => {
  it('repeated approval and replayed creation never duplicate tasks', async () => {
    const team = await createTeam('approval');
    await subscribeAll(team.commander);
    await subscribeAll(team.responder);
    const inc = await newIncident(team.commander, team.orgId);
    const idem = key('task');
    const args = { incidentId: inc.id, title: 'Preserve DB server memory image', description: '', priority: 'P1', assignedIdentity: team.responder.identity, requiresApproval: true, idempotencyKey: idem };
    await Promise.all([team.commander.conn.reducers.createTask(args), team.commander.conn.reducers.createTask(args), team.commander.conn.reducers.createTask(args)]);
    const task = await waitFor('task', () => [...team.commander.conn.db.myTasks.iter()].find(t => t.incidentId === inc.id));
    expect(task.status).toBe('AWAITING_APPROVAL');

    // Responder cannot start a task that awaits approval.
    await expectCode(team.responder.conn.reducers.updateTaskStatus({ taskId: task.id, expectedVersion: 1, toStatus: 'IN_PROGRESS', note: '' }), 'INVALID_TRANSITION');

    await Promise.all([1, 2, 3].map(() => team.commander.conn.reducers.approveTask({ taskId: task.id, reason: 'go' })));
    await team.commander.conn.reducers.approveTask({ taskId: task.id, reason: 'again' });
    const approved = await waitFor('approved', () => [...team.responder.conn.db.myTasks.iter()].find(t => t.id === task.id && t.approvalStatus === 'APPROVED'));
    expect(approved.version).toBe(2); // exactly one state change
    expect([...team.commander.conn.db.myTasks.iter()].filter(t => t.incidentId === inc.id)).toHaveLength(1);
    await expectCode(team.commander.conn.reducers.rejectTask({ taskId: task.id, reason: 'changed my mind' }), 'INVALID_TRANSITION');

    // Responder progresses the approved task; second client sees it live.
    await team.responder.conn.reducers.updateTaskStatus({ taskId: task.id, expectedVersion: 2, toStatus: 'IN_PROGRESS', note: 'started' });
    await team.responder.conn.reducers.updateTaskStatus({ taskId: task.id, expectedVersion: 3, toStatus: 'COMPLETED', note: 'image hashed' });
    await waitFor('commander sees completion', () => [...team.commander.conn.db.myTasks.iter()].find(t => t.id === task.id && t.status === 'COMPLETED'));
    await expectCode(team.responder.conn.reducers.updateTaskStatus({ taskId: task.id, expectedVersion: 4, toStatus: 'IN_PROGRESS', note: '' }), 'INVALID_TRANSITION');

    // The same client key from a different user is a conflict, not a silent merge.
    await subscribeAll(team.analyst);
    await expectCode(team.analyst.conn.reducers.createTask({ ...args, assignedIdentity: undefined }), 'VALIDATION_FAILED');
  });
});

describe('messaging', () => {
  it('delivers to a second client, dedupes resends, and rate-limits floods', async () => {
    const team = await createTeam('messaging');
    await subscribeAll(team.commander);
    await subscribeAll(team.responder);
    const inc = await newIncident(team.commander, team.orgId);
    const clientMessageId = key('msg');
    await team.responder.conn.reducers.sendMessage({ incidentId: inc.id, content: 'On site at server room', clientMessageId });
    await team.responder.conn.reducers.sendMessage({ incidentId: inc.id, content: 'On site at server room', clientMessageId });
    const msg = await waitFor('commander receives', () => [...team.commander.conn.db.myMessages.iter()].find(m => m.incidentId === inc.id));
    expect(msg.senderIdentity.isEqual(team.responder.identity)).toBe(true);
    expect([...team.commander.conn.db.myMessages.iter()].filter(m => m.incidentId === inc.id)).toHaveLength(1);

    let limited = false;
    for (let i = 0; i < 35 && !limited; i++) {
      try {
        await team.responder.conn.reducers.sendMessage({ incidentId: inc.id, content: `flood ${i}`, clientMessageId: key('flood') });
      } catch (e) {
        expect(String((e as Error).message)).toMatch(/^RATE_LIMITED: /);
        limited = true;
      }
    }
    expect(limited).toBe(true);
  });
});

describe('audit trail', () => {
  it('records every mutation in a verifiable per-organization hash chain without message content', async () => {
    const team = await createTeam('audit');
    await subscribeAll(team.commander);
    const inc = await newIncident(team.commander, team.orgId);
    const secret = `confidential-${key()}`;
    await team.commander.conn.reducers.sendMessage({ incidentId: inc.id, content: secret, clientMessageId: key() });
    await team.commander.conn.reducers.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: 1, toStatus: 'TRIAGING', reason: 'triage start', evidenceId: '' });
    await waitFor('status audited', () => [...team.commander.conn.db.myAuditEvents.iter()].find(e => e.eventType === 'INCIDENT_STATUS_CHANGED' && e.incidentId === inc.id));

    const events = [...team.commander.conn.db.myAuditEvents.iter()].filter(e => e.organizationId === team.orgId).sort((a, b) => Number(a.seq - b.seq));
    expect(events.map(e => e.eventType)).toEqual(
      expect.arrayContaining(['ORGANIZATION_CREATED', 'MEMBER_INVITED', 'INCIDENT_CREATED', 'MESSAGE_SENT', 'INCIDENT_STATUS_CHANGED'])
    );
    let prev = AUDIT_GENESIS_HASH;
    events.forEach((e, i) => {
      expect(e.seq).toBe(BigInt(i + 1));
      expect(e.previousHash).toBe(prev);
      const recomputed = computeAuditHash({
        organizationId: e.organizationId,
        incidentId: e.incidentId,
        seq: e.seq,
        actorHex: e.actorIdentity.toHexString(),
        actorKind: e.actorKind,
        eventType: e.eventType,
        targetId: e.targetId,
        timestampMicros: e.timestamp.microsSinceUnixEpoch,
        metadata: e.metadata,
        previousHash: e.previousHash,
      });
      expect(recomputed).toBe(e.eventHash);
      prev = e.eventHash;
    });
    expect(events.some(e => e.metadata.includes(secret))).toBe(false);
  });
});
