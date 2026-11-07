import { describe, it, expect, beforeEach } from 'vitest';
import { spacetimeClient } from '../services/spacetimeClient';
import { MOCK_USERS } from '../fixtures/mockData';

describe('Incident Lifecycle Reducers & Validation', () => {
  beforeEach(() => {
    // Reset to commander
    spacetimeClient.setCurrentUser(MOCK_USERS[0]); // Dr. Sarah Chen (COMMANDER)
  });

  it('allows valid sequential status transitions', async () => {
    // Current incident status in mock is 'CONTAINING'
    const res = await spacetimeClient.transitionIncidentStatus('CONTAINED');
    expect(res.status).toBe('CONTAINED');

    const next = await spacetimeClient.transitionIncidentStatus('RECOVERING');
    expect(next.status).toBe('RECOVERING');
  });

  it('rejects disallowed status transitions according to NIST lifecycle graph', async () => {
    // Trying to skip directly to CLOSED from CONTAINING or RECOVERING without allowed path
    // Reset to REPORTED for test
    const newInc = await spacetimeClient.createIncident({
      title: 'Lifecycle Test Incident',
      description: 'Testing lifecycle validation transitions',
      category: 'MALWARE',
      severity: 'HIGH',
      commander_identity: 'identity_sarah_chen',
    });

    expect(newInc.status).toBe('REPORTED');

    // REPORTED cannot jump directly to RECOVERING
    await expect(spacetimeClient.transitionIncidentStatus('RECOVERING')).rejects.toThrowError(
      /INVALID_TRANSITION/
    );
  });

  it('requires Commander role and justification when reopening a closed incident', async () => {
    // Fast forward to CLOSED
    await spacetimeClient.transitionIncidentStatus('CLOSED');

    // Observer attempting to reopen must fail
    spacetimeClient.setCurrentUser(MOCK_USERS[3]); // Observer
    await expect(spacetimeClient.transitionIncidentStatus('TRIAGING', 'Need reopen')).rejects.toThrowError(
      /ACCESS_DENIED/
    );

    // Commander without adequate justification must fail
    spacetimeClient.setCurrentUser(MOCK_USERS[0]); // Commander
    await expect(spacetimeClient.transitionIncidentStatus('TRIAGING', 'short')).rejects.toThrowError(
      /VALIDATION_FAILED/
    );

    // Commander with thorough justification succeeds
    const reopened = await spacetimeClient.transitionIncidentStatus(
      'TRIAGING',
      'Detailed justification: secondary lateral infection detected on workstation subnet.'
    );
    expect(reopened.status).toBe('TRIAGING');
  });
});

