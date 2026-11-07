import { afterAll, describe, expect, it } from 'vitest';
import { adminActor, connect, disconnectAll, expectCode, httpSql, key, subscribe, waitFor } from './client';
import { createTeam, newIncident, subscribeAll } from './fixtures';

afterAll(() => disconnectAll());

describe('membership revocation', () => {
  it('removes rows from an EXISTING live subscription and blocks new reads and writes', async () => {
    const team = await createTeam('revoke');
    await subscribeAll(team.commander);
    await subscribeAll(team.analyst);
    const inc = await newIncident(team.commander, team.orgId);
    await team.commander.conn.reducers.sendMessage({ incidentId: inc.id, content: 'status update', clientMessageId: key() });
    await waitFor('analyst sees incident', () => [...team.analyst.conn.db.myIncidents.iter()].find(i => i.id === inc.id));
    await waitFor('analyst sees message', () => [...team.analyst.conn.db.myMessages.iter()].find(m => m.incidentId === inc.id));

    const deletedIncidents: string[] = [];
    team.analyst.conn.db.myIncidents.onDelete((_ctx, row) => deletedIncidents.push(row.id));

    await team.owner.conn.reducers.revokeMember({ membershipId: team.membershipIdOf(team.analyst), reason: 'device reported stolen' });

    // Existing subscription: the per-sender view is re-evaluated and rows are deleted client-side.
    await waitFor('incident removed from live subscription', () => deletedIncidents.includes(inc.id));
    await waitFor('messages removed', () => [...team.analyst.conn.db.myMessages.iter()].length === 0);
    expect([...team.analyst.conn.db.myIncidents.iter()]).toHaveLength(0);
    expect([...team.analyst.conn.db.myAuditEvents.iter()]).toHaveLength(0);
    // The analyst's own membership row remains visible, marked revoked.
    const own = [...team.analyst.conn.db.myMemberships.iter()].find(m => m.organizationId === team.orgId);
    expect(own?.revokedAt).toBeDefined();

    // New writes are rejected.
    await expectCode(team.analyst.conn.reducers.sendMessage({ incidentId: inc.id, content: 'still here?', clientMessageId: key() }), 'INCIDENT_NOT_FOUND');
    await expectCode(
      team.analyst.conn.reducers.createIncident({ organizationId: team.orgId, title: 'After revoke', description: '', category: 'OTHER', severity: 'LOW', detectedAt: undefined, idempotencyKey: key() }),
      'ACCESS_DENIED'
    );

    // New connection + new subscription with the same token sees nothing.
    const again = await connect('analyst-reconnect', team.analyst.token);
    await subscribe(again, ['SELECT * FROM my_incidents', 'SELECT * FROM my_messages']);
    expect([...again.conn.db.myIncidents.iter()]).toHaveLength(0);
    const sql = await httpSql(team.analyst.token, 'SELECT id FROM my_incidents');
    expect(JSON.parse(sql.body)[0].rows).toHaveLength(0);

    // The commander is unaffected.
    expect([...team.commander.conn.db.myIncidents.iter()].find(i => i.id === inc.id)).toBeDefined();
  });

  it('cannot revoke the last OWNER, and revocation is idempotent', async () => {
    const team = await createTeam('last-owner');
    await team.owner.conn.reducers.revokeMember({ membershipId: team.membershipIdOf(team.admin), reason: 'hand over to team owner' });
    await expectCode(team.owner.conn.reducers.revokeMember({ membershipId: team.membershipIdOf(team.owner), reason: 'leaving' }), 'VALIDATION_FAILED');
    const id = team.membershipIdOf(team.responder);
    await team.owner.conn.reducers.revokeMember({ membershipId: id, reason: 'rotation' });
    await team.owner.conn.reducers.revokeMember({ membershipId: id, reason: 'rotation' });
  });

  it('platform-disabled users lose access everywhere', async () => {
    const team = await createTeam('disable');
    await subscribeAll(team.commander);
    await subscribeAll(team.analyst);
    const inc = await newIncident(team.commander, team.orgId);
    await waitFor('analyst sees', () => [...team.analyst.conn.db.myIncidents.iter()].find(i => i.id === inc.id));
    const admin = await adminActor();
    await admin.conn.reducers.setUserDisabled({ userIdentity: team.analyst.identity, disabled: true });
    await waitFor('rows dropped after disable', () => [...team.analyst.conn.db.myIncidents.iter()].length === 0);
    await expectCode(team.analyst.conn.reducers.sendMessage({ incidentId: inc.id, content: 'hi', clientMessageId: key() }), 'INCIDENT_NOT_FOUND');
    await expectCode(team.analyst.conn.reducers.registerProfile({ displayName: 'trying to re-enable' }), 'ACCESS_DENIED');
    await expectCode(team.analyst.conn.reducers.setUserDisabled({ userIdentity: team.analyst.identity, disabled: false }), 'ACCESS_DENIED');
    await admin.conn.reducers.setUserDisabled({ userIdentity: team.analyst.identity, disabled: false });
    await waitFor('rows restored after enable', () => [...team.analyst.conn.db.myIncidents.iter()].find(i => i.id === inc.id));
  });
});
