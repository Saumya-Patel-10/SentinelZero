import { afterAll, describe, expect, it } from 'vitest';
import { disconnectAll, expectCode, httpCall, key, newActor, subscribe, waitFor } from './client';
import { createTeam, newIncident, subscribeAll } from './fixtures';

afterAll(() => disconnectAll());

describe('reducer-level authorization', () => {
  it('derives every actor field from the authenticated sender, never from the request body', async () => {
    const team = await createTeam('impersonation');
    await subscribeAll(team.commander);
    await subscribeAll(team.analyst);
    const inc = await newIncident(team.analyst, team.orgId);
    // Analyst created it: createdBy is the analyst, and the analyst is not auto-made commander.
    expect(inc.createdBy.isEqual(team.analyst.identity)).toBe(true);
    expect(inc.commanderIdentity).toBeUndefined();

    // No reducer accepts an actor/approver/role/tenant override. Extra fields in the HTTP body are rejected.
    const forged = await httpCall(team.analyst.token, 'approve_task', ['nonexistent-task', '', team.commander.identity.toHexString()]);
    expect(forged.status).toBeGreaterThanOrEqual(400);

    // An analyst cannot approve, even when targeting a real task.
    await team.analyst.conn.reducers.createTask({
      incidentId: inc.id,
      title: 'Isolate scheduling DB host',
      description: '',
      priority: 'P1',
      assignedIdentity: undefined,
      requiresApproval: true,
      idempotencyKey: key('task'),
    });
    const task = await waitFor('task visible', () => [...team.analyst.conn.db.myTasks.iter()].find(t => t.incidentId === inc.id));
    expect(task.createdBy.isEqual(team.analyst.identity)).toBe(true);
    await expectCode(team.analyst.conn.reducers.approveTask({ taskId: task.id, reason: '' }), 'ACCESS_DENIED');

    // Commander approval records the commander as approver regardless of anything the client sends.
    await team.commander.conn.reducers.approveTask({ taskId: task.id, reason: 'approved' });
    const approved = await waitFor('approved', () =>
      [...team.analyst.conn.db.myTasks.iter()].find(t => t.id === task.id && t.approvalStatus === 'APPROVED')
    );
    expect(approved.approvedBy?.isEqual(team.commander.identity)).toBe(true);
    expect(approved.status).toBe('PENDING');
  });

  it('observers cannot mutate anything', async () => {
    const team = await createTeam('observer');
    await subscribeAll(team.commander);
    const inc = await newIncident(team.commander, team.orgId);
    const o = team.observer.conn.reducers;
    await expectCode(o.updateIncident({ incidentId: inc.id, expectedVersion: 1, title: 'x'.repeat(5), description: '', category: 'OTHER', severity: 'LOW' }), 'ACCESS_DENIED');
    await expectCode(o.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: 1, toStatus: 'TRIAGING', reason: 'triage', evidenceId: '' }), 'ACCESS_DENIED');
    await expectCode(o.addAsset({ incidentId: inc.id, name: 'db01', assetType: 'DATABASE', criticality: 'HIGH', compromiseStatus: 'UNKNOWN', availabilityStatus: 'UNKNOWN', description: '' }), 'ACCESS_DENIED');
    await expectCode(o.createTask({ incidentId: inc.id, title: 'Do a thing', description: '', priority: 'P2', assignedIdentity: undefined, requiresApproval: false, idempotencyKey: key() }), 'ACCESS_DENIED');
    await expectCode(o.sendMessage({ incidentId: inc.id, content: 'hello', clientMessageId: key() }), 'ACCESS_DENIED');
    await expectCode(o.requestAgentRun({ incidentId: inc.id, analysisType: 'intake', idempotencyKey: key() }), 'ACCESS_DENIED');
    await expectCode(o.inviteMember({ organizationId: team.orgId, userIdentity: team.observer.identity, role: 'OWNER' }), 'ACCESS_DENIED');
  });

  it('responders act only on their assigned tasks', async () => {
    const team = await createTeam('responder');
    await subscribeAll(team.commander);
    await subscribeAll(team.responder);
    const inc = await newIncident(team.commander, team.orgId);
    for (const assignee of [team.responder.identity, undefined]) {
      await team.commander.conn.reducers.createTask({
        incidentId: inc.id,
        title: assignee ? 'Assigned to responder' : 'Unassigned task',
        description: '',
        priority: 'P2',
        assignedIdentity: assignee,
        requiresApproval: false,
        idempotencyKey: key(),
      });
    }
    const mine = await waitFor('mine', () => [...team.responder.conn.db.myTasks.iter()].find(t => t.title === 'Assigned to responder'));
    const other = await waitFor('other', () => [...team.responder.conn.db.myTasks.iter()].find(t => t.title === 'Unassigned task'));
    await team.responder.conn.reducers.updateTaskStatus({ taskId: mine.id, expectedVersion: 1, toStatus: 'IN_PROGRESS', note: 'on it' });
    await expectCode(team.responder.conn.reducers.updateTaskStatus({ taskId: other.id, expectedVersion: 1, toStatus: 'IN_PROGRESS', note: '' }), 'ACCESS_DENIED');
    await expectCode(team.responder.conn.reducers.updateTaskStatus({ taskId: mine.id, expectedVersion: 2, toStatus: 'CANCELLED', note: '' }), 'ACCESS_DENIED');
    await expectCode(team.responder.conn.reducers.assignTask({ taskId: other.id, expectedVersion: 1, assignedIdentity: team.responder.identity }), 'ACCESS_DENIED');
    // Observers cannot be assigned work.
    await expectCode(team.commander.conn.reducers.assignTask({ taskId: other.id, expectedVersion: 1, assignedIdentity: team.observer.identity }), 'VALIDATION_FAILED');
  });

  it('cross-tenant writes fail without disclosing incident existence', async () => {
    const team = await createTeam('tenant-a');
    const other = await createTeam('tenant-b');
    await subscribeAll(team.commander);
    const inc = await newIncident(team.commander, team.orgId);
    const r = other.commander.conn.reducers;
    await expectCode(r.updateIncident({ incidentId: inc.id, expectedVersion: 1, title: 'hijacked', description: '', category: 'OTHER', severity: 'LOW' }), 'INCIDENT_NOT_FOUND');
    await expectCode(r.sendMessage({ incidentId: inc.id, content: 'hi', clientMessageId: key() }), 'INCIDENT_NOT_FOUND');
    await expectCode(r.addAsset({ incidentId: inc.id, name: 'x', assetType: 'SERVER', criticality: 'LOW', compromiseStatus: 'UNKNOWN', availabilityStatus: 'UNKNOWN', description: '' }), 'INCIDENT_NOT_FOUND');
    await expectCode(r.updateIncident({ incidentId: 'does-not-exist', expectedVersion: 1, title: 'nothing', description: '', category: 'OTHER', severity: 'LOW' }), 'INCIDENT_NOT_FOUND');
    // Owner of tenant B cannot invite into tenant A.
    await expectCode(other.owner.conn.reducers.inviteMember({ organizationId: team.orgId, userIdentity: other.commander.identity, role: 'COMMANDER' }), 'ACCESS_DENIED');
    // Only a platform admin can create organizations.
    await expectCode(team.commander.conn.reducers.createOrganization({ name: 'Rogue org', dataClass: 'LIVE' }), 'ACCESS_DENIED');
  });

  it('enforces lifecycle transitions, commander-only reopen, and optimistic versions', async () => {
    const team = await createTeam('lifecycle');
    await subscribeAll(team.commander);
    const inc = await newIncident(team.commander, team.orgId);
    const c = team.commander.conn.reducers;
    await expectCode(c.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: 1, toStatus: 'CONTAINED', reason: 'skip', evidenceId: '' }), 'INVALID_TRANSITION');
    let v = 1;
    for (const to of ['TRIAGING', 'INVESTIGATING', 'CONTAINING', 'CONTAINED', 'RECOVERING', 'RESOLVED']) {
      await c.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: v, toStatus: to, reason: `move to ${to}`, evidenceId: '' });
      v++;
    }
    await expectCode(c.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: v - 1, toStatus: 'CLOSED', reason: 'stale', evidenceId: '' }), 'VERSION_CONFLICT');
    await c.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: v, toStatus: 'CLOSED', reason: 'done', evidenceId: '' });
    v++;
    // Closed incidents are read-only.
    await expectCode(c.addAsset({ incidentId: inc.id, name: 'late', assetType: 'SERVER', criticality: 'LOW', compromiseStatus: 'UNKNOWN', availabilityStatus: 'UNKNOWN', description: '' }), 'INVALID_TRANSITION');
    // OWNER may not reopen; COMMANDER must give an explanation.
    await subscribe(team.owner, ['SELECT * FROM my_incidents']);
    await expectCode(team.owner.conn.reducers.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: v, toStatus: 'INVESTIGATING', reason: 'reopen please', evidenceId: '' }), 'ACCESS_DENIED');
    await expectCode(c.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: v, toStatus: 'INVESTIGATING', reason: 'why', evidenceId: '' }), 'VALIDATION_FAILED');
    await c.transitionIncidentStatus({ incidentId: inc.id, expectedVersion: v, toStatus: 'INVESTIGATING', reason: 'New encrypted hosts found on ward network', evidenceId: '' });
    await waitFor('reopened', () => [...team.commander.conn.db.myIncidents.iter()].find(i => i.id === inc.id && i.status === 'INVESTIGATING'));
  });

  it('rejects malformed and oversized input', async () => {
    const team = await createTeam('validation');
    await subscribeAll(team.commander);
    const inc = await newIncident(team.commander, team.orgId);
    const c = team.commander.conn.reducers;
    await expectCode(c.sendMessage({ incidentId: inc.id, content: 'x'.repeat(4001), clientMessageId: key() }), 'VALIDATION_FAILED');
    await expectCode(c.sendMessage({ incidentId: inc.id, content: 'bidi \u202E override', clientMessageId: key() }), 'VALIDATION_FAILED');
    await expectCode(c.sendMessage({ incidentId: inc.id, content: '   ', clientMessageId: key() }), 'VALIDATION_FAILED');
    await expectCode(c.sendMessage({ incidentId: inc.id, content: 'ok', clientMessageId: 'short' }), 'VALIDATION_FAILED');
    await expectCode(c.createIncident({ organizationId: team.orgId, title: 'Bad severity', description: '', category: 'RANSOMWARE', severity: 'APOCALYPTIC', detectedAt: undefined, idempotencyKey: key() }), 'VALIDATION_FAILED');
    await expectCode(c.appendEvidenceReference({ incidentId: inc.id, evidenceType: 'LOG_EXPORT', source: 'siem export', sha256: 'not-a-hash', classification: 'CONFIDENTIAL', description: '' }), 'VALIDATION_FAILED');
    // HTML is stored verbatim as text (clients must not render it as HTML).
    const html = '<img src=x onerror=alert(1)>';
    await c.sendMessage({ incidentId: inc.id, content: html, clientMessageId: key() });
    const msg = await waitFor('html msg', () => [...team.commander.conn.db.myMessages.iter()].find(m => m.incidentId === inc.id));
    expect(msg.content).toBe(html);
  });

  it('anonymous HTTP callers cannot invoke privileged reducers', async () => {
    const team = await createTeam('anon');
    const outsider = await newActor('outsider');
    const res = await httpCall(null, 'invite_member', [team.orgId, { __identity__: outsider.identity.toHexString() }, 'OWNER']);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
