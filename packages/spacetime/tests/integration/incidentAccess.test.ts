import { afterAll, describe, expect, it } from 'vitest';
import { disconnectAll, expectCode, httpSql, key, newActor, subscribe, waitFor } from './client';
import { createTeam } from './fixtures';

afterAll(() => disconnectAll());

describe('incident subscriptions and read isolation', () => {
  it('two authorized clients observe a committed incident; outsiders and observers do not', async () => {
    const team = await createTeam('access');
    const outsider = await newActor('outsider');
    const otherTeam = await createTeam('other-tenant');

    await subscribe(team.commander, ['SELECT * FROM my_incidents']);
    await subscribe(team.analyst, ['SELECT * FROM my_incidents']);
    await subscribe(team.observer, ['SELECT * FROM my_incidents', 'SELECT * FROM my_incident_summaries']);
    await subscribe(outsider, ['SELECT * FROM my_incidents', 'SELECT * FROM my_incident_summaries']);
    await subscribe(otherTeam.commander, ['SELECT * FROM my_incidents', 'SELECT * FROM my_incident_summaries']);

    const title = `Ransomware ${key()}`;
    await team.commander.conn.reducers.createIncident({
      organizationId: team.orgId,
      title,
      description: 'EXERCISE: scheduling database encrypted',
      category: 'RANSOMWARE',
      severity: 'CRITICAL',
      detectedAt: undefined,
      idempotencyKey: key('inc'),
    });

    const seenByCommander = await waitFor('commander sees incident', () =>
      [...team.commander.conn.db.myIncidents.iter()].find(i => i.title === title)
    );
    const seenByAnalyst = await waitFor('analyst sees incident', () =>
      [...team.analyst.conn.db.myIncidents.iter()].find(i => i.title === title)
    );
    expect(seenByAnalyst.id).toBe(seenByCommander.id);
    expect(seenByCommander.status).toBe('REPORTED');
    expect(seenByCommander.dataClass).toBe('EXERCISE');
    expect(seenByCommander.createdBy.isEqual(team.commander.identity)).toBe(true);
    expect(seenByCommander.commanderIdentity?.isEqual(team.commander.identity)).toBe(true);

    // Observer gets the limited summary projection only.
    await waitFor('observer sees summary', () =>
      [...team.observer.conn.db.myIncidentSummaries.iter()].find(i => i.id === seenByCommander.id)
    );
    expect([...team.observer.conn.db.myIncidents.iter()]).toHaveLength(0);

    // Live update propagates to the second client.
    await team.analyst.conn.reducers.updateIncident({
      incidentId: seenByCommander.id,
      expectedVersion: 1,
      title,
      description: 'EXERCISE: updated by analyst',
      category: 'RANSOMWARE',
      severity: 'HIGH',
    });
    await waitFor('commander sees analyst update', () =>
      [...team.commander.conn.db.myIncidents.iter()].find(i => i.id === seenByCommander.id && i.version === 2 && i.severity === 'HIGH')
    );

    // Non-member and other tenant received nothing.
    await new Promise(r => setTimeout(r, 300));
    expect([...outsider.conn.db.myIncidents.iter()]).toHaveLength(0);
    expect([...outsider.conn.db.myIncidentSummaries.iter()]).toHaveLength(0);
    expect([...otherTeam.commander.conn.db.myIncidents.iter()].find(i => i.id === seenByCommander.id)).toBeUndefined();
    expect([...otherTeam.commander.conn.db.myIncidentSummaries.iter()].find(i => i.id === seenByCommander.id)).toBeUndefined();
  });

  it('private base tables cannot be subscribed to or queried by clients', async () => {
    const team = await createTeam('private-tables');
    const outsider = await newActor('outsider');
    await expect(subscribe(outsider, ['SELECT * FROM incident'])).rejects.toBeDefined();
    await expect(subscribe(team.commander, ['SELECT * FROM incident'])).rejects.toBeDefined();
    await expect(subscribe(team.commander, ['SELECT * FROM membership'])).rejects.toBeDefined();

    for (const table of ['incident', 'membership', 'audit_event', 'message', 'data_scope', 'service_principal']) {
      const res = await httpSql(outsider.token, `SELECT * FROM ${table}`);
      expect(res.status, `${table} should be rejected`).toBeGreaterThanOrEqual(400);
    }
    const anon = await httpSql(null, 'SELECT * FROM incident');
    expect(anon.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects incident writes from outsiders, observers and other tenants', async () => {
    const team = await createTeam('writes');
    const outsider = await newActor('outsider');
    const other = await createTeam('writes-other');
    const args = {
      organizationId: team.orgId,
      title: 'Should not exist',
      description: '',
      category: 'MALWARE',
      severity: 'LOW',
      detectedAt: undefined,
      idempotencyKey: key('inc'),
    };
    await expectCode(outsider.conn.reducers.createIncident(args), 'ACCESS_DENIED');
    await expectCode(team.observer.conn.reducers.createIncident(args), 'ACCESS_DENIED');
    await expectCode(team.responder.conn.reducers.createIncident(args), 'ACCESS_DENIED');
    await expectCode(other.commander.conn.reducers.createIncident(args), 'ACCESS_DENIED');
  });
});
