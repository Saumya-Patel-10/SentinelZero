import { t } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import spacetimedb, { agentRunSweepSchedule } from '../schema';
import { fail, newId } from '../security/context';
import { appendAudit } from '../security/audit';
import { activeMembership, activeServicePrincipal, canInOrg, requireIncidentCapability } from '../security/membership';
import { consumeRateLimit } from '../security/rateLimit';
import { idempotencyKey, oneOf, stringList, text } from '../security/validation';
import { guardedTx, iso, recordToolCall, requireServiceRun } from '../workflows/agentAccess';
import { insertTask, requireAssignable } from '../workflows/tasks';
import { AGENT_ERROR_CATEGORIES, ANALYSIS_TYPES, INFERENCE_MODES, TASK_PRIORITIES, type Role } from '../../../shared/src/enums';
import { AGENT_RUN_LEASE_SECONDS, LIMITS } from '../../../shared/src/limits';
import { roleHas } from '../../../shared/src/permissions';

const MAX_RECOMMENDATIONS_PER_RUN = 10;
const REQUESTED_RUN_TTL_MICROS = 10n * 60n * 1_000_000n;

// ======================= Human-facing reducers =======================

export const request_agent_run = spacetimedb.reducer(
  { incidentId: t.string(), analysisType: t.string(), idempotencyKey: t.string() },
  (ctx, a) => {
    const { incident } = requireIncidentCapability(ctx, a.incidentId, 'REQUEST_AGENT_RUN');
    oneOf('analysisType', ANALYSIS_TYPES, a.analysisType);
    idempotencyKey('idempotencyKey', a.idempotencyKey);
    const scopedKey = `${ctx.sender.toHexString()}:${a.idempotencyKey}`;
    if (ctx.db.agentRun.idempotencyKey.find(scopedKey)) return; // idempotent
    consumeRateLimit(ctx, 'request_agent_run');
    const id = newId(ctx);
    ctx.db.agentRun.insert({
      id,
      organizationId: incident.organizationId,
      incidentId: incident.id,
      requestedBy: ctx.sender,
      analysisType: a.analysisType,
      status: 'REQUESTED',
      claimedBy: undefined,
      modelIdentifier: '',
      inferenceMode: '',
      createdAt: ctx.timestamp,
      startedAt: undefined,
      finishedAt: undefined,
      leaseExpiresAt: undefined,
      errorCategory: 'NONE',
      summary: '',
      idempotencyKey: scopedKey,
    });
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: 'AGENT_RUN_REQUESTED',
      targetId: id,
      metadata: { analysisType: a.analysisType },
    });
  }
);

export const cancel_agent_run = spacetimedb.reducer({ runId: t.string(), reason: t.string() }, (ctx, a) => {
  const run = ctx.db.agentRun.id.find(a.runId);
  if (!run) fail('NOT_FOUND', 'agent run not found');
  const { membership } = requireIncidentCapability(ctx, run.incidentId, 'VIEW_AGENT_ACTIVITY');
  const isRequester = run.requestedBy.isEqual(ctx.sender);
  if (!isRequester && !roleHas(membership.role as Role, 'DECIDE_RECOMMENDATION')) fail('ACCESS_DENIED', 'only the requester or a commander may cancel');
  text('reason', a.reason, LIMITS.REASON);
  if (run.status === 'CANCELLED') return;
  if (run.status !== 'REQUESTED' && run.status !== 'RUNNING') fail('INVALID_TRANSITION', `agent run is ${run.status}`);
  ctx.db.agentRun.id.update({ ...run, status: 'CANCELLED', errorCategory: 'CANCELLED', finishedAt: ctx.timestamp });
  appendAudit(ctx, {
    organizationId: run.organizationId,
    incidentId: run.incidentId,
    actorKind: 'USER',
    eventType: 'AGENT_RUN_CANCELLED',
    targetId: run.id,
    metadata: { reason: a.reason },
  });
});

/**
 * Human approval of an AI proposal. Creates exactly one task per recommendation:
 * repeated approval is a no-op, and the task's unique idempotency key `rec:<id>` makes a
 * duplicate structurally impossible.
 */
export const approve_recommendation = spacetimedb.reducer(
  { recommendationId: t.string(), assignedIdentity: t.option(t.identity()), reason: t.string() },
  (ctx, a) => {
    const rec = ctx.db.recommendation.id.find(a.recommendationId);
    if (!rec) fail('NOT_FOUND', 'recommendation not found');
    const { incident } = requireIncidentCapability(ctx, rec.incidentId, 'DECIDE_RECOMMENDATION');
    text('reason', a.reason, { min: 0, max: LIMITS.REASON.max });
    if (rec.status === 'APPROVED') return; // idempotent
    if (rec.status !== 'PENDING') fail('INVALID_TRANSITION', `recommendation is ${rec.status}`);
    if (incident.status === 'CLOSED') fail('INVALID_TRANSITION', 'closed incidents are read-only; reopen first');
    requireAssignable(ctx, rec.organizationId, a.assignedIdentity);

    const idem = `rec:${rec.id}`;
    const existingTask = ctx.db.task.idempotencyKey.find(idem);
    const taskId =
      existingTask?.id ??
      insertTask(ctx, {
        organizationId: rec.organizationId,
        incidentId: rec.incidentId,
        title: rec.title,
        description: rec.description,
        priority: rec.priority,
        assignedIdentity: a.assignedIdentity,
        status: 'PENDING',
        approvalStatus: 'APPROVED',
        approvedBy: ctx.sender,
        source: 'AI_RECOMMENDATION',
        sourceRecommendationId: rec.id,
        idempotencyKey: idem,
      });
    ctx.db.recommendation.id.update({
      ...rec,
      status: 'APPROVED',
      createdTaskId: taskId,
      decidedBy: ctx.sender,
      decidedAt: ctx.timestamp,
      decisionReason: a.reason,
    });
    appendAudit(ctx, {
      organizationId: rec.organizationId,
      incidentId: rec.incidentId,
      actorKind: 'USER',
      eventType: 'RECOMMENDATION_APPROVED',
      targetId: rec.id,
      metadata: { taskId, inferenceMode: rec.inferenceMode },
    });
  }
);

export const reject_recommendation = spacetimedb.reducer({ recommendationId: t.string(), reason: t.string() }, (ctx, a) => {
  const rec = ctx.db.recommendation.id.find(a.recommendationId);
  if (!rec) fail('NOT_FOUND', 'recommendation not found');
  requireIncidentCapability(ctx, rec.incidentId, 'DECIDE_RECOMMENDATION');
  text('reason', a.reason, LIMITS.REASON);
  if (rec.status === 'REJECTED') return;
  if (rec.status !== 'PENDING') fail('INVALID_TRANSITION', `recommendation is ${rec.status}`);
  ctx.db.recommendation.id.update({ ...rec, status: 'REJECTED', decidedBy: ctx.sender, decidedAt: ctx.timestamp, decisionReason: a.reason });
  appendAudit(ctx, {
    organizationId: rec.organizationId,
    incidentId: rec.incidentId,
    actorKind: 'USER',
    eventType: 'RECOMMENDATION_REJECTED',
    targetId: rec.id,
    metadata: { reason: a.reason },
  });
});

// ======================= Verification for the AI service =======================

const RunAccess = t.object('RunAccess', {
  authorized: t.bool(),
  isRequester: t.bool(),
  role: t.string(),
  runId: t.string(),
  incidentId: t.string(),
  organizationId: t.string(),
  status: t.string(),
});

/**
 * Called by FastAPI WITH THE END USER'S TOKEN to bind an HTTP request to a verified identity.
 * Never throws for unauthorized callers; returns authorized=false without disclosing details.
 */
export const verify_agent_run_access = spacetimedb.procedure({ runId: t.string() }, RunAccess, (ctx, { runId }) =>
  ctx.withTx(tx => {
    const denied = { authorized: false, isRequester: false, role: '', runId, incidentId: '', organizationId: '', status: '' };
    const run = tx.db.agentRun.id.find(runId);
    if (!run) return denied;
    const m = activeMembership(tx.db, run.organizationId, tx.sender);
    if (!m || !roleHas(m.role as Role, 'VIEW_AGENT_ACTIVITY')) return denied;
    return {
      authorized: true,
      isRequester: run.requestedBy.isEqual(tx.sender),
      role: m.role,
      runId,
      incidentId: run.incidentId,
      organizationId: run.organizationId,
      status: run.status,
    };
  })
);

// ======================= Service-principal reducers =======================

export const agent_claim_run = spacetimedb.reducer(
  { runId: t.string(), modelIdentifier: t.string(), inferenceMode: t.string() },
  (ctx, a) => {
    const run = ctx.db.agentRun.id.find(a.runId);
    if (!run) fail('NOT_FOUND', 'agent run not found');
    if (!activeServicePrincipal(ctx.db, run.organizationId, ctx.sender)) fail('ACCESS_DENIED', 'not a service principal for this organization');
    text('modelIdentifier', a.modelIdentifier, LIMITS.SHORT_TEXT);
    oneOf('inferenceMode', INFERENCE_MODES, a.inferenceMode);
    if (run.status === 'RUNNING' && run.claimedBy?.isEqual(ctx.sender)) return; // idempotent
    if (run.status !== 'REQUESTED') fail('INVALID_TRANSITION', `agent run is ${run.status}`);
    if (!canInOrg(ctx.db, run.organizationId, run.requestedBy, 'REQUEST_AGENT_RUN')) fail('ACCESS_DENIED', 'requesting user no longer has access');
    const lease = new Timestamp(ctx.timestamp.microsSinceUnixEpoch + BigInt(AGENT_RUN_LEASE_SECONDS) * 1_000_000n);
    ctx.db.agentRun.id.update({
      ...run,
      status: 'RUNNING',
      claimedBy: ctx.sender,
      modelIdentifier: a.modelIdentifier,
      inferenceMode: a.inferenceMode,
      startedAt: ctx.timestamp,
      leaseExpiresAt: lease,
    });
    appendAudit(ctx, {
      organizationId: run.organizationId,
      incidentId: run.incidentId,
      actorKind: 'SERVICE',
      eventType: 'AGENT_RUN_STARTED',
      targetId: run.id,
      metadata: { modelIdentifier: a.modelIdentifier, inferenceMode: a.inferenceMode },
    });
  }
);

/** The `propose_task` tool. Creates a PENDING recommendation only; never a task. */
export const agent_submit_recommendation = spacetimedb.reducer(
  {
    runId: t.string(),
    clientKey: t.string(),
    title: t.string(),
    description: t.string(),
    priority: t.string(),
    rationale: t.string(),
    evidenceIds: t.array(t.string()),
    uncertainties: t.array(t.string()),
  },
  (ctx, a) => {
    const run = requireServiceRun(ctx, a.runId);
    idempotencyKey('clientKey', a.clientKey);
    text('title', a.title, LIMITS.TITLE);
    text('description', a.description, LIMITS.DESCRIPTION);
    oneOf('priority', TASK_PRIORITIES, a.priority);
    text('rationale', a.rationale, LIMITS.RATIONALE);
    stringList('evidenceIds', a.evidenceIds, LIMITS.SHORT_TEXT);
    stringList('uncertainties', a.uncertainties, LIMITS.LIST_ITEM);
    if (a.evidenceIds.length === 0 && a.uncertainties.length === 0) {
      fail('VALIDATION_FAILED', 'a recommendation must cite evidence or state its uncertainties');
    }
    for (const evId of a.evidenceIds) {
      const ev = ctx.db.evidenceReference.id.find(evId);
      if (!ev || ev.incidentId !== run.incidentId) fail('VALIDATION_FAILED', `evidence ${evId} does not belong to this incident`);
    }
    const dedupeKey = `${run.id}:${a.clientKey}`;
    if (ctx.db.recommendation.dedupeKey.find(dedupeKey)) return; // idempotent retry
    if ([...ctx.db.recommendation.agentRunId.filter(run.id)].length >= MAX_RECOMMENDATIONS_PER_RUN) {
      fail('RATE_LIMITED', 'too many recommendations for this run');
    }
    const id = newId(ctx);
    ctx.db.recommendation.insert({
      id,
      organizationId: run.organizationId,
      incidentId: run.incidentId,
      agentRunId: run.id,
      title: a.title,
      description: a.description,
      priority: a.priority,
      rationale: a.rationale,
      evidenceIds: a.evidenceIds,
      uncertainties: a.uncertainties,
      inferenceMode: run.inferenceMode,
      modelIdentifier: run.modelIdentifier,
      status: 'PENDING',
      createdTaskId: '',
      decidedBy: undefined,
      decidedAt: undefined,
      decisionReason: '',
      createdAt: ctx.timestamp,
      dedupeKey,
    });
    recordToolCall(ctx, run, 'propose_task', `title=${a.title}`, `recommendation=${id}`, 'OK');
    appendAudit(ctx, {
      organizationId: run.organizationId,
      incidentId: run.incidentId,
      actorKind: 'SERVICE',
      eventType: 'RECOMMENDATION_PROPOSED',
      targetId: id,
      metadata: { runId: run.id, inferenceMode: run.inferenceMode, evidenceCount: a.evidenceIds.length },
    });
  }
);

export const agent_complete_run = spacetimedb.reducer(
  { runId: t.string(), status: t.string(), errorCategory: t.string(), summary: t.string() },
  (ctx, a) => {
    const run = requireServiceRun(ctx, a.runId);
    const status = oneOf('status', ['COMPLETED', 'FAILED'] as const, a.status);
    oneOf('errorCategory', AGENT_ERROR_CATEGORIES, a.errorCategory);
    if (status === 'COMPLETED' && a.errorCategory !== 'NONE') fail('VALIDATION_FAILED', 'COMPLETED runs must use errorCategory NONE');
    text('summary', a.summary, { min: 0, max: LIMITS.DESCRIPTION.max });
    ctx.db.agentRun.id.update({ ...run, status, errorCategory: a.errorCategory, summary: a.summary, finishedAt: ctx.timestamp });
    appendAudit(ctx, {
      organizationId: run.organizationId,
      incidentId: run.incidentId,
      actorKind: 'SERVICE',
      eventType: status === 'COMPLETED' ? 'AGENT_RUN_COMPLETED' : 'AGENT_RUN_FAILED',
      targetId: run.id,
      metadata: { errorCategory: a.errorCategory },
    });
  }
);

// ======================= Service-principal read tools (procedures) =======================

const AgentIncident = t.object('AgentIncident', {
  runId: t.string(),
  analysisType: t.string(),
  incidentId: t.string(),
  title: t.string(),
  description: t.string(),
  category: t.string(),
  severity: t.string(),
  status: t.string(),
  dataClass: t.string(),
  reportedAt: t.string(),
  detectedAt: t.string(),
  updatedAt: t.string(),
});

const AgentDataScope = t.object('AgentDataScope', {
  id: t.string(),
  dataCategory: t.string(),
  sensitivity: t.string(),
  lockStatus: t.string(),
  exfiltrationStatus: t.string(),
  integrityStatus: t.string(),
  estimatedRecords: t.string(),
  confidence: t.string(),
  evidenceId: t.string(),
});

const AgentAsset = t.object('AgentAsset', {
  id: t.string(),
  name: t.string(),
  assetType: t.string(),
  criticality: t.string(),
  compromiseStatus: t.string(),
  availabilityStatus: t.string(),
  lastVerifiedAt: t.string(),
  dataScopes: t.array(AgentDataScope),
});

const AgentService = t.object('AgentService', {
  id: t.string(),
  name: t.string(),
  criticality: t.string(),
  availabilityStatus: t.string(),
  availabilityVerification: t.string(),
});

const AgentDependency = t.object('AgentDependency', {
  id: t.string(),
  sourceAssetId: t.string(),
  targetServiceId: t.string(),
  dependencyType: t.string(),
  verification: t.string(),
});

const AgentImpact = t.object('AgentImpact', {
  id: t.string(),
  serviceId: t.string(),
  impactType: t.string(),
  severity: t.string(),
  verification: t.string(),
  affectedGroup: t.string(),
  description: t.string(),
});

const AgentDependencyGraph = t.object('AgentDependencyGraph', {
  services: t.array(AgentService),
  dependencies: t.array(AgentDependency),
  impacts: t.array(AgentImpact),
});

const AgentTask = t.object('AgentTask', {
  id: t.string(),
  title: t.string(),
  priority: t.string(),
  status: t.string(),
  approvalStatus: t.string(),
  source: t.string(),
  assigned: t.bool(),
});

const AgentEvidence = t.object('AgentEvidence', {
  id: t.string(),
  evidenceType: t.string(),
  source: t.string(),
  sha256: t.string(),
  classification: t.string(),
  description: t.string(),
  recordedAt: t.string(),
});

export const agent_get_incident = spacetimedb.procedure({ runId: t.string() }, t.result(AgentIncident, t.string()), (ctx, { runId }) =>
  guardedTx(ctx, tx => {
    const run = requireServiceRun(tx, runId);
    const i = tx.db.incident.id.find(run.incidentId)!;
    recordToolCall(tx, run, 'get_incident', `incident=${i.id}`, 'incident record', 'OK');
    return {
      runId: run.id,
      analysisType: run.analysisType,
      incidentId: i.id,
      title: i.title,
      description: i.description,
      category: i.category,
      severity: i.severity,
      status: i.status,
      dataClass: i.dataClass,
      reportedAt: iso(i.reportedAt),
      detectedAt: iso(i.detectedAt),
      updatedAt: iso(i.updatedAt),
    };
  })
);

export const agent_get_assets = spacetimedb.procedure({ runId: t.string() }, t.result(t.array(AgentAsset), t.string()), (ctx, { runId }) =>
  guardedTx(ctx, tx => {
    const run = requireServiceRun(tx, runId);
    const scopes = [...tx.db.dataScope.incidentId.filter(run.incidentId)];
    const out = [...tx.db.asset.incidentId.filter(run.incidentId)].map(a => ({
      id: a.id,
      name: a.name,
      assetType: a.assetType,
      criticality: a.criticality,
      compromiseStatus: a.compromiseStatus,
      availabilityStatus: a.availabilityStatus,
      lastVerifiedAt: iso(a.lastVerifiedAt),
      dataScopes: scopes
        .filter(s => s.assetId === a.id)
        .map(s => ({
          id: s.id,
          dataCategory: s.dataCategory,
          sensitivity: s.sensitivity,
          lockStatus: s.lockStatus,
          exfiltrationStatus: s.exfiltrationStatus,
          integrityStatus: s.integrityStatus,
          estimatedRecords: s.estimatedRecords === undefined ? '' : s.estimatedRecords.toString(),
          confidence: s.confidence,
          evidenceId: s.evidenceId,
        })),
    }));
    recordToolCall(tx, run, 'get_assets', `incident=${run.incidentId}`, `${out.length} assets`, 'OK');
    return out;
  })
);

export const agent_get_dependencies = spacetimedb.procedure({ runId: t.string() }, t.result(AgentDependencyGraph, t.string()), (ctx, { runId }) =>
  guardedTx(ctx, tx => {
    const run = requireServiceRun(tx, runId);
    const services = [...tx.db.service.incidentId.filter(run.incidentId)].map(s => ({
      id: s.id,
      name: s.name,
      criticality: s.criticality,
      availabilityStatus: s.availabilityStatus,
      availabilityVerification: s.availabilityVerification,
    }));
    const dependencies = [...tx.db.serviceDependency.incidentId.filter(run.incidentId)].map(d => ({
      id: d.id,
      sourceAssetId: d.sourceAssetId,
      targetServiceId: d.targetServiceId,
      dependencyType: d.dependencyType,
      verification: d.verification,
    }));
    const impacts = [...tx.db.operationalImpact.incidentId.filter(run.incidentId)].map(i => ({
      id: i.id,
      serviceId: i.serviceId,
      impactType: i.impactType,
      severity: i.severity,
      verification: i.verification,
      affectedGroup: i.affectedGroup,
      description: i.description,
    }));
    recordToolCall(
      tx,
      run,
      'get_dependencies',
      `incident=${run.incidentId}`,
      `${services.length} services, ${dependencies.length} dependencies, ${impacts.length} impacts`,
      'OK'
    );
    return { services, dependencies, impacts };
  })
);

export const agent_get_open_tasks = spacetimedb.procedure({ runId: t.string() }, t.result(t.array(AgentTask), t.string()), (ctx, { runId }) =>
  guardedTx(ctx, tx => {
    const run = requireServiceRun(tx, runId);
    const out = [...tx.db.task.incidentId.filter(run.incidentId)]
      .filter(x => x.status !== 'COMPLETED' && x.status !== 'CANCELLED')
      .map(x => ({
        id: x.id,
        title: x.title,
        priority: x.priority,
        status: x.status,
        approvalStatus: x.approvalStatus,
        source: x.source,
        assigned: x.assignedIdentity !== undefined,
      }));
    recordToolCall(tx, run, 'get_open_tasks', `incident=${run.incidentId}`, `${out.length} open tasks`, 'OK');
    return out;
  })
);

export const agent_get_evidence_summaries = spacetimedb.procedure({ runId: t.string() }, t.result(t.array(AgentEvidence), t.string()), (ctx, { runId }) =>
  guardedTx(ctx, tx => {
    const run = requireServiceRun(tx, runId);
    const out = [...tx.db.evidenceReference.incidentId.filter(run.incidentId)].map(e => ({
      id: e.id,
      evidenceType: e.evidenceType,
      source: e.source,
      sha256: e.sha256,
      classification: e.classification,
      description: e.description,
      recordedAt: iso(e.recordedAt),
    }));
    recordToolCall(tx, run, 'get_evidence_summaries', `incident=${run.incidentId}`, `${out.length} evidence refs`, 'OK');
    return out;
  })
);

// ======================= Maintenance =======================

/** Expires REQUESTED runs older than 10 minutes and RUNNING runs past their lease. */
export const sweep_agent_runs = spacetimedb.reducer({ onSchedule: agentRunSweepSchedule }, { timer: agentRunSweepSchedule.rowType }, ctx => {
  if (!ctx.senderAuth.isInternal) fail('ACCESS_DENIED', 'scheduled reducer');
  const now = ctx.timestamp.microsSinceUnixEpoch;
  for (const run of [...ctx.db.agentRun.iter()]) {
    const expired =
      (run.status === 'REQUESTED' && now - run.createdAt.microsSinceUnixEpoch > REQUESTED_RUN_TTL_MICROS) ||
      (run.status === 'RUNNING' && run.leaseExpiresAt !== undefined && now > run.leaseExpiresAt.microsSinceUnixEpoch);
    if (!expired) continue;
    ctx.db.agentRun.id.update({ ...run, status: 'EXPIRED', errorCategory: 'TIMEOUT', finishedAt: ctx.timestamp });
    appendAudit(ctx, {
      organizationId: run.organizationId,
      incidentId: run.incidentId,
      actorKind: 'PLATFORM',
      eventType: 'AGENT_RUN_EXPIRED',
      targetId: run.id,
    });
  }
});
