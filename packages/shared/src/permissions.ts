import type { Role } from './enums';

/**
 * Role capability matrix. FROZEN v1. The SpacetimeDB module enforces this server-side;
 * clients may use it only to hide/disable UI affordances.
 */
export const CAPABILITIES = {
  // Organization administration
  MANAGE_MEMBERS: ['OWNER'],
  MANAGE_SERVICE_PRINCIPALS: ['OWNER'],
  VIEW_MEMBER_DIRECTORY: ['OWNER', 'COMMANDER', 'ANALYST', 'RESPONDER'],

  // Incident lifecycle
  VIEW_INCIDENT_SUMMARY: ['OWNER', 'COMMANDER', 'ANALYST', 'RESPONDER', 'OBSERVER'],
  VIEW_INCIDENT_DETAIL: ['OWNER', 'COMMANDER', 'ANALYST', 'RESPONDER'],
  CREATE_INCIDENT: ['OWNER', 'COMMANDER', 'ANALYST'],
  UPDATE_INCIDENT: ['OWNER', 'COMMANDER', 'ANALYST'],
  TRANSITION_INCIDENT: ['OWNER', 'COMMANDER'],
  REOPEN_INCIDENT: ['COMMANDER'],
  ASSIGN_COMMANDER: ['OWNER', 'COMMANDER'],

  // Impact graph (assets, services, dependencies, impacts)
  VIEW_IMPACT_GRAPH: ['OWNER', 'COMMANDER', 'ANALYST', 'RESPONDER'],
  EDIT_IMPACT_GRAPH: ['OWNER', 'COMMANDER', 'ANALYST'],

  // Sensitive investigation data
  VIEW_DATA_SCOPE: ['OWNER', 'COMMANDER', 'ANALYST'],
  EDIT_DATA_SCOPE: ['OWNER', 'COMMANDER', 'ANALYST'],
  VIEW_EVIDENCE: ['OWNER', 'COMMANDER', 'ANALYST'],
  APPEND_EVIDENCE: ['OWNER', 'COMMANDER', 'ANALYST'],
  VIEW_AUDIT: ['OWNER', 'COMMANDER', 'ANALYST'],

  // Tasks
  VIEW_TASKS: ['OWNER', 'COMMANDER', 'ANALYST', 'RESPONDER'],
  CREATE_TASK: ['OWNER', 'COMMANDER', 'ANALYST'],
  ASSIGN_TASK: ['OWNER', 'COMMANDER', 'ANALYST'],
  /** Assignees may additionally update their own task regardless of role (except OBSERVER). */
  UPDATE_ANY_TASK: ['OWNER', 'COMMANDER', 'ANALYST'],
  CANCEL_TASK: ['OWNER', 'COMMANDER', 'ANALYST'],
  APPROVE_TASK: ['OWNER', 'COMMANDER'],

  // Communications
  VIEW_MESSAGES: ['OWNER', 'COMMANDER', 'ANALYST', 'RESPONDER'],
  SEND_MESSAGE: ['OWNER', 'COMMANDER', 'ANALYST', 'RESPONDER'],

  // AI
  REQUEST_AGENT_RUN: ['OWNER', 'COMMANDER', 'ANALYST'],
  VIEW_AGENT_ACTIVITY: ['OWNER', 'COMMANDER', 'ANALYST'],
  DECIDE_RECOMMENDATION: ['OWNER', 'COMMANDER'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

export function roleHas(role: Role, capability: Capability): boolean {
  return (CAPABILITIES[capability] as readonly Role[]).includes(role);
}
