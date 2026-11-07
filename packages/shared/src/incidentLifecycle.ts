import type { IncidentStatus } from './enums';

/** Forward/lateral transitions. Reopen transitions are listed separately. FROZEN v1. */
export const INCIDENT_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  REPORTED: ['TRIAGING', 'CLOSED'],
  TRIAGING: ['INVESTIGATING', 'CLOSED'],
  INVESTIGATING: ['CONTAINING', 'RESOLVED'],
  CONTAINING: ['CONTAINED', 'INVESTIGATING'],
  CONTAINED: ['RECOVERING', 'CONTAINING'],
  RECOVERING: ['RESOLVED', 'CONTAINING'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

/** Reopen: COMMANDER role only, explanation required (>= REOPEN_REASON_MIN_LENGTH chars). */
export const INCIDENT_REOPEN_TRANSITIONS: Readonly<Partial<Record<IncidentStatus, readonly IncidentStatus[]>>> = {
  RESOLVED: ['INVESTIGATING'],
  CLOSED: ['INVESTIGATING'],
};

export const REOPEN_REASON_MIN_LENGTH = 10;

export type IncidentTransitionKind = 'FORWARD' | 'REOPEN' | 'INVALID';

export function classifyIncidentTransition(from: IncidentStatus, to: IncidentStatus): IncidentTransitionKind {
  if (INCIDENT_TRANSITIONS[from].includes(to)) return 'FORWARD';
  if (INCIDENT_REOPEN_TRANSITIONS[from]?.includes(to)) return 'REOPEN';
  return 'INVALID';
}
