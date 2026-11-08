import { afterAll, describe, expect, it } from 'vitest';
import { auditStatus, createIncident, graphFor, openSession, subscribeCommandCenter, transition, waitForRow } from '../../examples/clientExample';
import { dbName, disconnectAll, stdbUri } from './client';
import { createTeam } from './fixtures';

afterAll(disconnectAll);

describe('docs/INTEGRATION_CONTRACT.md client example', () => {
  it('runs the documented connect → subscribe → intake → transition → audit flow', async () => {
    const team = await createTeam('contract-example');
    const analyst = await openSession(stdbUri(), dbName(), team.analyst.token);
    const commander = await openSession(stdbUri(), dbName(), team.commander.token);
    const stale = await openSession(stdbUri(), dbName(), team.commander.token);
    try {
      await subscribeCommandCenter(analyst);
      await subscribeCommandCenter(commander);
      await subscribeCommandCenter(stale);

      const info = [...analyst.conn.db.backendInfo.iter()][0];
      expect(info?.contractVersion).toBe('1.1.0');

      const incident = await createIncident(analyst, team.orgId, `Contract example ${Date.now()}`);
      expect(incident.status).toBe('REPORTED');
      const staleRow = await waitForRow(() => [...stale.conn.db.myIncidents.iter()].find(i => i.id === incident.id));

      expect(await transition(commander, incident.id, incident.version, 'TRIAGING', 'Triage started')).toBeNull();
      const err = await transition(stale, incident.id, staleRow.version, 'CLOSED', 'Stale screen');
      expect(err?.code).toBe('VERSION_CONFLICT');

      await waitForRow(() => [...commander.conn.db.myIncidentTimeline.iter()].find(e => e.incidentId === incident.id && e.eventType === 'INCIDENT_STATUS_CHANGED'));
      expect(graphFor(commander, incident.id).nodes).toEqual([]);

      const verification = auditStatus(commander, team.orgId);
      expect(verification.status).toBe('VERIFIED');
      expect(verification.headChecked).toBe(true);
    } finally {
      for (const s of [analyst, commander, stale]) s.conn.disconnect();
    }
  });
});
