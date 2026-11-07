import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { fail } from '../security/context';
import { appendAudit } from '../security/audit';
import { requireIncidentCapability } from '../security/membership';
import { expectVersion, idempotencyKey, oneOf, text } from '../security/validation';
import { insertTask, requireAssignable } from '../workflows/tasks';
import { TASK_PRIORITIES, TASK_STATUSES, type ApprovalStatus, type Role, type TaskStatus } from '../../../shared/src/enums';
import { decideApproval, isValidTaskTransition } from '../../../shared/src/taskLifecycle';
import { LIMITS } from '../../../shared/src/limits';
import { roleHas } from '../../../shared/src/permissions';

export const create_task = spacetimedb.reducer(
  {
    incidentId: t.string(),
    title: t.string(),
    description: t.string(),
    priority: t.string(),
    assignedIdentity: t.option(t.identity()),
    requiresApproval: t.bool(),
    idempotencyKey: t.string(),
  },
  (ctx, a) => {
    const { incident, membership } = requireIncidentCapability(ctx, a.incidentId, 'CREATE_TASK');
    if (incident.status === 'CLOSED') fail('INVALID_TRANSITION', 'closed incidents are read-only; reopen first');
    text('title', a.title, LIMITS.TITLE);
    text('description', a.description, LIMITS.DESCRIPTION);
    oneOf('priority', TASK_PRIORITIES, a.priority);
    idempotencyKey('idempotencyKey', a.idempotencyKey);
    requireAssignable(ctx, incident.organizationId, a.assignedIdentity);

    const scopedKey = `${incident.id}:${a.idempotencyKey}`;
    const existing = ctx.db.task.idempotencyKey.find(scopedKey);
    if (existing) {
      if (existing.createdBy.isEqual(ctx.sender)) return; // idempotent replay
      fail('VALIDATION_FAILED', 'idempotencyKey already used');
    }

    // Approvers creating a task that "requires approval" still go through explicit approval.
    const id = insertTask(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      title: a.title,
      description: a.description,
      priority: a.priority,
      assignedIdentity: a.assignedIdentity,
      status: a.requiresApproval ? 'AWAITING_APPROVAL' : 'PENDING',
      approvalStatus: a.requiresApproval ? 'PENDING' : 'NOT_REQUIRED',
      approvedBy: undefined,
      source: 'HUMAN',
      sourceRecommendationId: '',
      idempotencyKey: scopedKey,
    });
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: 'TASK_CREATED',
      targetId: id,
      metadata: { priority: a.priority, requiresApproval: a.requiresApproval, creatorRole: membership.role },
    });
  }
);

export const assign_task = spacetimedb.reducer(
  { taskId: t.string(), expectedVersion: t.u32(), assignedIdentity: t.option(t.identity()) },
  (ctx, a) => {
    const task = ctx.db.task.id.find(a.taskId);
    if (!task) fail('NOT_FOUND', 'task not found');
    requireIncidentCapability(ctx, task.incidentId, 'ASSIGN_TASK');
    expectVersion('task', task.version, a.expectedVersion);
    if (task.status === 'COMPLETED' || task.status === 'CANCELLED') fail('INVALID_TRANSITION', 'task is closed');
    requireAssignable(ctx, task.organizationId, a.assignedIdentity);
    ctx.db.task.id.update({ ...task, assignedIdentity: a.assignedIdentity, updatedAt: ctx.timestamp, version: task.version + 1 });
    appendAudit(ctx, {
      organizationId: task.organizationId,
      incidentId: task.incidentId,
      actorKind: 'USER',
      eventType: 'TASK_ASSIGNED',
      targetId: task.id,
      metadata: { assignee: a.assignedIdentity?.toHexString() ?? null },
    });
  }
);

export const update_task_status = spacetimedb.reducer(
  { taskId: t.string(), expectedVersion: t.u32(), toStatus: t.string(), note: t.string() },
  (ctx, a) => {
    const task = ctx.db.task.id.find(a.taskId);
    if (!task) fail('NOT_FOUND', 'task not found');
    // Any detail-level member may attempt; capability is then narrowed below.
    const { membership } = requireIncidentCapability(ctx, task.incidentId, 'VIEW_TASKS');
    const role = membership.role as Role;
    const isAssignee = task.assignedIdentity !== undefined && task.assignedIdentity.isEqual(ctx.sender);
    if (!isAssignee && !roleHas(role, 'UPDATE_ANY_TASK')) fail('ACCESS_DENIED', 'only the assignee or an analyst/commander may update this task');

    expectVersion('task', task.version, a.expectedVersion);
    const to = oneOf('toStatus', TASK_STATUSES, a.toStatus);
    text('note', a.note, { min: 0, max: LIMITS.REASON.max });
    if (to === 'CANCELLED' && !roleHas(role, 'CANCEL_TASK')) fail('ACCESS_DENIED', `role ${role} cannot cancel tasks`);
    if (!isValidTaskTransition(task.status as TaskStatus, to)) fail('INVALID_TRANSITION', `${task.status} -> ${to} is not allowed`);

    ctx.db.task.id.update({ ...task, status: to, updatedAt: ctx.timestamp, version: task.version + 1 });
    appendAudit(ctx, {
      organizationId: task.organizationId,
      incidentId: task.incidentId,
      actorKind: 'USER',
      eventType: 'TASK_STATUS_CHANGED',
      targetId: task.id,
      metadata: { from: task.status, to, note: a.note },
    });
  }
);

function decide(decision: 'APPROVE' | 'REJECT') {
  return spacetimedb.reducer({ taskId: t.string(), reason: t.string() }, (ctx, a) => {
    const task = ctx.db.task.id.find(a.taskId);
    if (!task) fail('NOT_FOUND', 'task not found');
    requireIncidentCapability(ctx, task.incidentId, 'APPROVE_TASK');
    text('reason', a.reason, decision === 'REJECT' ? LIMITS.REASON : { min: 0, max: LIMITS.REASON.max });
    const outcome = decideApproval(task.approvalStatus as ApprovalStatus, decision);
    if (outcome.kind === 'NOOP') return; // repeated decision is idempotent
    if (outcome.kind === 'CONFLICT') fail('INVALID_TRANSITION', outcome.reason);
    ctx.db.task.id.update({
      ...task,
      status: outcome.status,
      approvalStatus: outcome.approval,
      approvedBy: ctx.sender,
      decidedAt: ctx.timestamp,
      decisionReason: a.reason,
      updatedAt: ctx.timestamp,
      version: task.version + 1,
    });
    appendAudit(ctx, {
      organizationId: task.organizationId,
      incidentId: task.incidentId,
      actorKind: 'USER',
      eventType: decision === 'APPROVE' ? 'TASK_APPROVED' : 'TASK_REJECTED',
      targetId: task.id,
      metadata: { reason: a.reason },
    });
  });
}

export const approve_task = decide('APPROVE');
export const reject_task = decide('REJECT');
