import type { ApprovalStatus, TaskStatus } from './enums';

/**
 * Transitions reachable through update_task_status. FROZEN v1.
 * AWAITING_APPROVAL is left only through approve_task (-> PENDING) or reject_task (-> CANCELLED).
 * COMPLETED and CANCELLED are terminal.
 */
export const TASK_STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  PENDING: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
  AWAITING_APPROVAL: [],
  IN_PROGRESS: ['BLOCKED', 'COMPLETED', 'CANCELLED'],
  BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_STATUS_TRANSITIONS[from].includes(to);
}

export type ApprovalDecision = 'APPROVE' | 'REJECT';

export type ApprovalOutcome =
  | { kind: 'APPLY'; status: TaskStatus; approval: ApprovalStatus }
  /** Same decision already recorded: idempotent no-op. */
  | { kind: 'NOOP' }
  | { kind: 'CONFLICT'; reason: string };

/** Pure approval state machine shared by approve_task / reject_task. */
export function decideApproval(current: ApprovalStatus, decision: ApprovalDecision): ApprovalOutcome {
  if (current === 'NOT_REQUIRED') return { kind: 'CONFLICT', reason: 'task does not require approval' };
  if (decision === 'APPROVE') {
    if (current === 'APPROVED') return { kind: 'NOOP' };
    if (current === 'REJECTED') return { kind: 'CONFLICT', reason: 'task was already rejected' };
    return { kind: 'APPLY', status: 'PENDING', approval: 'APPROVED' };
  }
  if (current === 'REJECTED') return { kind: 'NOOP' };
  if (current === 'APPROVED') return { kind: 'CONFLICT', reason: 'task was already approved' };
  return { kind: 'APPLY', status: 'CANCELLED', approval: 'REJECTED' };
}
