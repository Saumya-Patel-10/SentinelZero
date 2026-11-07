import { afterAll, describe, expect, it } from 'vitest';
import { disconnectAll, httpCall, key, waitFor } from './client';
import { createTeam, newIncident, subscribeAll } from './fixtures';

afterAll(() => disconnectAll());

describe('HTTP argument encoding (documented in docs/api-contracts.md)', () => {
  it('accepts option as {"some": v} / {"none": []} and identity as ["0x<hex>"]', async () => {
    const team = await createTeam('http-enc');
    await subscribeAll(team.analyst);
    const inc = await newIncident(team.analyst, team.orgId);
    const responderHex = team.responder.identity.toHexString();

    const withAssignee = await httpCall(team.analyst.token, 'create_task', {
      incidentId: inc.id,
      title: 'Assigned over HTTP',
      description: '',
      priority: 'P2',
      assignedIdentity: { some: [`0x${responderHex}`] },
      requiresApproval: false,
      idempotencyKey: key('http'),
    } as unknown as unknown[]);
    expect(withAssignee).toEqual({ status: 200, body: '' });

    const unassigned = await httpCall(team.analyst.token, 'create_task', [inc.id, 'Unassigned over HTTP', '', 'P3', { none: [] }, true, key('http')]);
    expect(unassigned.status).toBe(200);

    const a = await waitFor('assigned task', () => [...team.analyst.conn.db.myTasks.iter()].find(t => t.title === 'Assigned over HTTP'));
    expect(a.assignedIdentity?.toHexString()).toBe(responderHex);
    const u = await waitFor('unassigned task', () => [...team.analyst.conn.db.myTasks.iter()].find(t => t.title === 'Unassigned over HTTP'));
    expect(u.assignedIdentity).toBeUndefined();
    expect(u.status).toBe('AWAITING_APPROVAL');
  });
});
