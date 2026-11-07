import type { Identity } from 'spacetimedb';
import { fail, newId, type Ctx } from '../security/context';
import { activeMembership } from '../security/membership';
import type { ApprovalStatus, TaskSource, TaskStatus } from '../../../shared/src/enums';

export function requireAssignable(ctx: Ctx, organizationId: string, assignee: Identity | undefined): void {
  if (assignee === undefined) return;
  const m = activeMembership(ctx.db, organizationId, assignee);
  if (!m || m.role === 'OBSERVER') fail('VALIDATION_FAILED', 'assignee must be an active non-observer member');
}

export interface NewTask {
  organizationId: string;
  incidentId: string;
  title: string;
  description: string;
  priority: string;
  assignedIdentity: Identity | undefined;
  status: TaskStatus;
  approvalStatus: ApprovalStatus;
  approvedBy: Identity | undefined;
  source: TaskSource;
  sourceRecommendationId: string;
  idempotencyKey: string;
}

export function insertTask(ctx: Ctx, t: NewTask): string {
  const id = newId(ctx);
  const decided = t.approvalStatus === 'APPROVED' || t.approvalStatus === 'REJECTED';
  ctx.db.task.insert({
    id,
    organizationId: t.organizationId,
    incidentId: t.incidentId,
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: t.status,
    assignedIdentity: t.assignedIdentity,
    approvalStatus: t.approvalStatus,
    approvedBy: t.approvedBy,
    decidedAt: decided ? ctx.timestamp : undefined,
    decisionReason: '',
    source: t.source,
    sourceRecommendationId: t.sourceRecommendationId,
    createdBy: ctx.sender,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
    version: 1,
    idempotencyKey: t.idempotencyKey,
  });
  return id;
}
