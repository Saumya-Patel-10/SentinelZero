import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { fail, newId } from '../security/context';
import { appendAudit } from '../security/audit';
import { activeMembership, requireIncidentCapability, requireOrgCapability } from '../security/membership';
import { consumeRateLimit } from '../security/rateLimit';
import { expectVersion, idempotencyKey, oneOf, requireOpenIncident, text } from '../security/validation';
import { INCIDENT_CATEGORIES, INCIDENT_STATUSES, SEVERITIES, type IncidentStatus } from '../../../shared/src/enums';
import { classifyIncidentTransition, REOPEN_REASON_MIN_LENGTH } from '../../../shared/src/incidentLifecycle';
import { LIMITS } from '../../../shared/src/limits';
import { roleHas } from '../../../shared/src/permissions';

export const create_incident = spacetimedb.reducer(
  {
    organizationId: t.string(),
    title: t.string(),
    description: t.string(),
    category: t.string(),
    severity: t.string(),
    detectedAt: t.option(t.timestamp()),
    idempotencyKey: t.string(),
  },
  (ctx, args) => {
    const m = requireOrgCapability(ctx, args.organizationId, 'CREATE_INCIDENT');
    text('title', args.title, LIMITS.TITLE);
    text('description', args.description, LIMITS.DESCRIPTION);
    oneOf('category', INCIDENT_CATEGORIES, args.category);
    oneOf('severity', SEVERITIES, args.severity);
    idempotencyKey('idempotencyKey', args.idempotencyKey);
    if (args.detectedAt && args.detectedAt.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch) {
      fail('VALIDATION_FAILED', 'detectedAt cannot be in the future');
    }

    const scopedKey = `${args.organizationId}:${args.idempotencyKey}`;
    const existing = ctx.db.incident.idempotencyKey.find(scopedKey);
    if (existing) {
      if (existing.createdBy.isEqual(ctx.sender)) return; // idempotent replay
      fail('VALIDATION_FAILED', 'idempotencyKey already used');
    }
    consumeRateLimit(ctx, 'create_incident');

    const org = ctx.db.organization.id.find(args.organizationId)!;
    const id = newId(ctx);
    ctx.db.incident.insert({
      id,
      organizationId: args.organizationId,
      title: args.title,
      description: args.description,
      category: args.category,
      severity: args.severity,
      status: 'REPORTED',
      commanderIdentity: m.role === 'COMMANDER' ? ctx.sender : undefined,
      dataClass: org.dataClass,
      detectedAt: args.detectedAt,
      reportedAt: ctx.timestamp,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      version: 1,
      idempotencyKey: scopedKey,
    });
    appendAudit(ctx, {
      organizationId: args.organizationId,
      incidentId: id,
      actorKind: 'USER',
      eventType: 'INCIDENT_CREATED',
      targetId: id,
      metadata: { severity: args.severity, category: args.category, dataClass: org.dataClass },
    });
  }
);

export const update_incident = spacetimedb.reducer(
  {
    incidentId: t.string(),
    expectedVersion: t.u32(),
    title: t.string(),
    description: t.string(),
    category: t.string(),
    severity: t.string(),
  },
  (ctx, args) => {
    const { incident } = requireIncidentCapability(ctx, args.incidentId, 'UPDATE_INCIDENT');
    expectVersion('incident', incident.version, args.expectedVersion);
    text('title', args.title, LIMITS.TITLE);
    text('description', args.description, LIMITS.DESCRIPTION);
    oneOf('category', INCIDENT_CATEGORIES, args.category);
    oneOf('severity', SEVERITIES, args.severity);
    requireOpenIncident(incident.status);
    consumeRateLimit(ctx, 'incident_write');
    ctx.db.incident.id.update({
      ...incident,
      title: args.title,
      description: args.description,
      category: args.category,
      severity: args.severity,
      updatedAt: ctx.timestamp,
      version: incident.version + 1,
    });
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: 'INCIDENT_UPDATED',
      targetId: incident.id,
      metadata: { severity: args.severity, previousSeverity: incident.severity },
    });
  }
);

export const transition_incident_status = spacetimedb.reducer(
  {
    incidentId: t.string(),
    expectedVersion: t.u32(),
    toStatus: t.string(),
    reason: t.string(),
    evidenceId: t.string(),
  },
  (ctx, args) => {
    const { incident, membership } = requireIncidentCapability(ctx, args.incidentId, 'TRANSITION_INCIDENT');
    expectVersion('incident', incident.version, args.expectedVersion);
    const to = oneOf('toStatus', INCIDENT_STATUSES, args.toStatus);
    text('reason', args.reason, LIMITS.REASON);
    if (args.evidenceId !== '') {
      const ev = ctx.db.evidenceReference.id.find(args.evidenceId);
      if (!ev || ev.incidentId !== incident.id) fail('VALIDATION_FAILED', 'evidenceId does not belong to this incident');
    }

    const kind = classifyIncidentTransition(incident.status as IncidentStatus, to);
    if (kind === 'INVALID') fail('INVALID_TRANSITION', `${incident.status} -> ${to} is not allowed`);
    if (kind === 'REOPEN') {
      if (!roleHas(membership.role as 'COMMANDER', 'REOPEN_INCIDENT')) fail('ACCESS_DENIED', 'only a COMMANDER may reopen an incident');
      if (args.reason.trim().length < REOPEN_REASON_MIN_LENGTH) {
        fail('VALIDATION_FAILED', `reopen requires an explanation of at least ${REOPEN_REASON_MIN_LENGTH} characters`);
      }
    }
    consumeRateLimit(ctx, 'incident_write');

    ctx.db.incident.id.update({ ...incident, status: to, updatedAt: ctx.timestamp, version: incident.version + 1 });
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: kind === 'REOPEN' ? 'INCIDENT_REOPENED' : 'INCIDENT_STATUS_CHANGED',
      targetId: incident.id,
      metadata: { from: incident.status, to, reason: args.reason, evidenceId: args.evidenceId || null },
    });
  }
);

export const assign_incident_commander = spacetimedb.reducer(
  { incidentId: t.string(), expectedVersion: t.u32(), commanderIdentity: t.identity() },
  (ctx, args) => {
    const { incident } = requireIncidentCapability(ctx, args.incidentId, 'ASSIGN_COMMANDER');
    expectVersion('incident', incident.version, args.expectedVersion);
    requireOpenIncident(incident.status);
    const target = activeMembership(ctx.db, incident.organizationId, args.commanderIdentity);
    if (!target || target.role !== 'COMMANDER') fail('VALIDATION_FAILED', 'commander must be an active COMMANDER member');
    consumeRateLimit(ctx, 'incident_write');
    ctx.db.incident.id.update({
      ...incident,
      commanderIdentity: args.commanderIdentity,
      updatedAt: ctx.timestamp,
      version: incident.version + 1,
    });
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: 'INCIDENT_COMMANDER_ASSIGNED',
      targetId: incident.id,
      metadata: { commander: args.commanderIdentity.toHexString() },
    });
  }
);
