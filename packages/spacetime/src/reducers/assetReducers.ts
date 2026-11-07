import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { fail, newId, type Ctx } from '../security/context';
import { appendAudit } from '../security/audit';
import { requireIncidentCapability } from '../security/membership';
import { expectVersion, oneOf, text } from '../security/validation';
import {
  ASSET_COMPROMISE,
  ASSET_TYPES,
  AVAILABILITY_STATUSES,
  CONFIDENCE,
  CRITICALITY,
  DATA_SENSITIVITY,
  DEPENDENCY_TYPES,
  IMPACT_TYPES,
  SEVERITIES,
  VERIFICATION,
} from '../../../shared/src/enums';
import { LIMITS } from '../../../shared/src/limits';

function requireOpenIncident(status: string): void {
  if (status === 'CLOSED') fail('INVALID_TRANSITION', 'closed incidents are read-only; reopen first');
}

function requireSameIncident(ctx: Ctx, kind: 'asset' | 'service', id: string, incidentId: string): void {
  const row = kind === 'asset' ? ctx.db.asset.id.find(id) : ctx.db.service.id.find(id);
  if (!row || row.incidentId !== incidentId) fail('VALIDATION_FAILED', `${kind} ${id} does not belong to this incident`);
}

function requireEvidenceOfIncident(ctx: Ctx, evidenceId: string, incidentId: string): void {
  if (evidenceId === '') return;
  const ev = ctx.db.evidenceReference.id.find(evidenceId);
  if (!ev || ev.incidentId !== incidentId) fail('VALIDATION_FAILED', 'evidenceId does not belong to this incident');
}

// ---------- Assets ----------

export const add_asset = spacetimedb.reducer(
  {
    incidentId: t.string(),
    name: t.string(),
    assetType: t.string(),
    criticality: t.string(),
    compromiseStatus: t.string(),
    availabilityStatus: t.string(),
    description: t.string(),
  },
  (ctx, a) => {
    const { incident } = requireIncidentCapability(ctx, a.incidentId, 'EDIT_IMPACT_GRAPH');
    requireOpenIncident(incident.status);
    text('name', a.name, LIMITS.SHORT_TEXT);
    oneOf('assetType', ASSET_TYPES, a.assetType);
    oneOf('criticality', CRITICALITY, a.criticality);
    oneOf('compromiseStatus', ASSET_COMPROMISE, a.compromiseStatus);
    oneOf('availabilityStatus', AVAILABILITY_STATUSES, a.availabilityStatus);
    text('description', a.description, LIMITS.DESCRIPTION);
    const id = newId(ctx);
    ctx.db.asset.insert({
      id,
      organizationId: incident.organizationId,
      incidentId: incident.id,
      name: a.name,
      assetType: a.assetType,
      criticality: a.criticality,
      compromiseStatus: a.compromiseStatus,
      availabilityStatus: a.availabilityStatus,
      description: a.description,
      lastVerifiedAt: undefined,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      version: 1,
    });
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: 'ASSET_ADDED',
      targetId: id,
      metadata: { compromiseStatus: a.compromiseStatus, availabilityStatus: a.availabilityStatus },
    });
  }
);

export const update_asset_status = spacetimedb.reducer(
  {
    assetId: t.string(),
    expectedVersion: t.u32(),
    compromiseStatus: t.string(),
    availabilityStatus: t.string(),
    /** true when a responder has directly verified the current state. */
    verifiedNow: t.bool(),
    reason: t.string(),
  },
  (ctx, a) => {
    const row = ctx.db.asset.id.find(a.assetId);
    if (!row) fail('NOT_FOUND', 'asset not found');
    const { incident } = requireIncidentCapability(ctx, row.incidentId, 'EDIT_IMPACT_GRAPH');
    requireOpenIncident(incident.status);
    expectVersion('asset', row.version, a.expectedVersion);
    oneOf('compromiseStatus', ASSET_COMPROMISE, a.compromiseStatus);
    oneOf('availabilityStatus', AVAILABILITY_STATUSES, a.availabilityStatus);
    text('reason', a.reason, LIMITS.REASON);
    ctx.db.asset.id.update({
      ...row,
      compromiseStatus: a.compromiseStatus,
      availabilityStatus: a.availabilityStatus,
      lastVerifiedAt: a.verifiedNow ? ctx.timestamp : row.lastVerifiedAt,
      updatedAt: ctx.timestamp,
      version: row.version + 1,
    });
    appendAudit(ctx, {
      organizationId: row.organizationId,
      incidentId: row.incidentId,
      actorKind: 'USER',
      eventType: 'ASSET_STATUS_CHANGED',
      targetId: row.id,
      metadata: {
        fromCompromise: row.compromiseStatus,
        toCompromise: a.compromiseStatus,
        fromAvailability: row.availabilityStatus,
        toAvailability: a.availabilityStatus,
        verifiedNow: a.verifiedNow,
        reason: a.reason,
      },
    });
  }
);

// ---------- Services ----------

export const add_service = spacetimedb.reducer(
  {
    incidentId: t.string(),
    name: t.string(),
    description: t.string(),
    criticality: t.string(),
    availabilityStatus: t.string(),
    availabilityVerification: t.string(),
  },
  (ctx, a) => {
    const { incident } = requireIncidentCapability(ctx, a.incidentId, 'EDIT_IMPACT_GRAPH');
    requireOpenIncident(incident.status);
    text('name', a.name, LIMITS.SHORT_TEXT);
    text('description', a.description, LIMITS.DESCRIPTION);
    oneOf('criticality', CRITICALITY, a.criticality);
    oneOf('availabilityStatus', AVAILABILITY_STATUSES, a.availabilityStatus);
    oneOf('availabilityVerification', VERIFICATION, a.availabilityVerification);
    const id = newId(ctx);
    ctx.db.service.insert({
      id,
      organizationId: incident.organizationId,
      incidentId: incident.id,
      name: a.name,
      description: a.description,
      criticality: a.criticality,
      availabilityStatus: a.availabilityStatus,
      availabilityVerification: a.availabilityVerification,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      version: 1,
    });
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: 'SERVICE_ADDED',
      targetId: id,
      metadata: { availabilityStatus: a.availabilityStatus, verification: a.availabilityVerification },
    });
  }
);

export const update_service_status = spacetimedb.reducer(
  {
    serviceId: t.string(),
    expectedVersion: t.u32(),
    availabilityStatus: t.string(),
    availabilityVerification: t.string(),
    reason: t.string(),
  },
  (ctx, a) => {
    const row = ctx.db.service.id.find(a.serviceId);
    if (!row) fail('NOT_FOUND', 'service not found');
    const { incident } = requireIncidentCapability(ctx, row.incidentId, 'EDIT_IMPACT_GRAPH');
    requireOpenIncident(incident.status);
    expectVersion('service', row.version, a.expectedVersion);
    oneOf('availabilityStatus', AVAILABILITY_STATUSES, a.availabilityStatus);
    oneOf('availabilityVerification', VERIFICATION, a.availabilityVerification);
    text('reason', a.reason, LIMITS.REASON);
    ctx.db.service.id.update({
      ...row,
      availabilityStatus: a.availabilityStatus,
      availabilityVerification: a.availabilityVerification,
      updatedAt: ctx.timestamp,
      version: row.version + 1,
    });
    appendAudit(ctx, {
      organizationId: row.organizationId,
      incidentId: row.incidentId,
      actorKind: 'USER',
      eventType: 'SERVICE_STATUS_CHANGED',
      targetId: row.id,
      metadata: { from: row.availabilityStatus, to: a.availabilityStatus, verification: a.availabilityVerification, reason: a.reason },
    });
  }
);

// ---------- Dependencies ----------

export const add_service_dependency = spacetimedb.reducer(
  {
    incidentId: t.string(),
    sourceAssetId: t.string(),
    targetServiceId: t.string(),
    dependencyType: t.string(),
    verification: t.string(),
  },
  (ctx, a) => {
    const { incident } = requireIncidentCapability(ctx, a.incidentId, 'EDIT_IMPACT_GRAPH');
    requireOpenIncident(incident.status);
    requireSameIncident(ctx, 'asset', a.sourceAssetId, incident.id);
    requireSameIncident(ctx, 'service', a.targetServiceId, incident.id);
    oneOf('dependencyType', DEPENDENCY_TYPES, a.dependencyType);
    oneOf('verification', VERIFICATION, a.verification);
    const dedupeKey = `${incident.id}:${a.sourceAssetId}:${a.targetServiceId}:${a.dependencyType}`;
    if (ctx.db.serviceDependency.dedupeKey.find(dedupeKey)) return; // idempotent
    const id = newId(ctx);
    ctx.db.serviceDependency.insert({
      id,
      organizationId: incident.organizationId,
      incidentId: incident.id,
      sourceAssetId: a.sourceAssetId,
      targetServiceId: a.targetServiceId,
      dependencyType: a.dependencyType,
      verification: a.verification,
      verifiedAt: a.verification === 'CONFIRMED' ? ctx.timestamp : undefined,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      dedupeKey,
    });
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: 'DEPENDENCY_ADDED',
      targetId: id,
      metadata: { sourceAssetId: a.sourceAssetId, targetServiceId: a.targetServiceId, verification: a.verification },
    });
  }
);

export const update_dependency_verification = spacetimedb.reducer(
  { dependencyId: t.string(), verification: t.string(), reason: t.string() },
  (ctx, a) => {
    const row = ctx.db.serviceDependency.id.find(a.dependencyId);
    if (!row) fail('NOT_FOUND', 'dependency not found');
    const { incident } = requireIncidentCapability(ctx, row.incidentId, 'EDIT_IMPACT_GRAPH');
    requireOpenIncident(incident.status);
    oneOf('verification', VERIFICATION, a.verification);
    text('reason', a.reason, LIMITS.REASON);
    ctx.db.serviceDependency.id.update({
      ...row,
      verification: a.verification,
      verifiedAt: a.verification === 'CONFIRMED' ? ctx.timestamp : row.verifiedAt,
    });
    appendAudit(ctx, {
      organizationId: row.organizationId,
      incidentId: row.incidentId,
      actorKind: 'USER',
      eventType: 'DEPENDENCY_VERIFICATION_CHANGED',
      targetId: row.id,
      metadata: { from: row.verification, to: a.verification, reason: a.reason },
    });
  }
);

// ---------- Operational impact ----------

export const add_operational_impact = spacetimedb.reducer(
  {
    incidentId: t.string(),
    serviceId: t.string(),
    impactType: t.string(),
    severity: t.string(),
    verification: t.string(),
    affectedGroup: t.string(),
    description: t.string(),
  },
  (ctx, a) => {
    const { incident } = requireIncidentCapability(ctx, a.incidentId, 'EDIT_IMPACT_GRAPH');
    requireOpenIncident(incident.status);
    requireSameIncident(ctx, 'service', a.serviceId, incident.id);
    oneOf('impactType', IMPACT_TYPES, a.impactType);
    oneOf('severity', SEVERITIES, a.severity);
    oneOf('verification', VERIFICATION, a.verification);
    text('affectedGroup', a.affectedGroup, { min: 0, max: LIMITS.SHORT_TEXT.max });
    text('description', a.description, LIMITS.DESCRIPTION);
    const id = newId(ctx);
    ctx.db.operationalImpact.insert({
      id,
      organizationId: incident.organizationId,
      incidentId: incident.id,
      serviceId: a.serviceId,
      impactType: a.impactType,
      severity: a.severity,
      verification: a.verification,
      affectedGroup: a.affectedGroup,
      description: a.description,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      version: 1,
    });
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: 'IMPACT_ADDED',
      targetId: id,
      metadata: { serviceId: a.serviceId, impactType: a.impactType, severity: a.severity, verification: a.verification },
    });
  }
);

export const update_operational_impact = spacetimedb.reducer(
  {
    impactId: t.string(),
    expectedVersion: t.u32(),
    severity: t.string(),
    verification: t.string(),
    description: t.string(),
  },
  (ctx, a) => {
    const row = ctx.db.operationalImpact.id.find(a.impactId);
    if (!row) fail('NOT_FOUND', 'impact not found');
    const { incident } = requireIncidentCapability(ctx, row.incidentId, 'EDIT_IMPACT_GRAPH');
    requireOpenIncident(incident.status);
    expectVersion('impact', row.version, a.expectedVersion);
    oneOf('severity', SEVERITIES, a.severity);
    oneOf('verification', VERIFICATION, a.verification);
    text('description', a.description, LIMITS.DESCRIPTION);
    ctx.db.operationalImpact.id.update({
      ...row,
      severity: a.severity,
      verification: a.verification,
      description: a.description,
      updatedAt: ctx.timestamp,
      version: row.version + 1,
    });
    appendAudit(ctx, {
      organizationId: row.organizationId,
      incidentId: row.incidentId,
      actorKind: 'USER',
      eventType: 'IMPACT_UPDATED',
      targetId: row.id,
      metadata: { fromVerification: row.verification, toVerification: a.verification, severity: a.severity },
    });
  }
);

// ---------- Data scope ----------

/** Upsert keyed by (incident, asset, dataCategory). Locking and exfiltration are tracked separately. */
export const update_data_scope = spacetimedb.reducer(
  {
    incidentId: t.string(),
    assetId: t.string(),
    dataCategory: t.string(),
    sensitivity: t.string(),
    lockStatus: t.string(),
    exfiltrationStatus: t.string(),
    integrityStatus: t.string(),
    estimatedRecords: t.option(t.u64()),
    confidence: t.string(),
    evidenceId: t.string(),
  },
  (ctx, a) => {
    const { incident } = requireIncidentCapability(ctx, a.incidentId, 'EDIT_DATA_SCOPE');
    requireOpenIncident(incident.status);
    requireSameIncident(ctx, 'asset', a.assetId, incident.id);
    text('dataCategory', a.dataCategory, LIMITS.SHORT_TEXT);
    oneOf('sensitivity', DATA_SENSITIVITY, a.sensitivity);
    oneOf('lockStatus', VERIFICATION, a.lockStatus);
    oneOf('exfiltrationStatus', VERIFICATION, a.exfiltrationStatus);
    oneOf('integrityStatus', VERIFICATION, a.integrityStatus);
    oneOf('confidence', CONFIDENCE, a.confidence);
    if (a.estimatedRecords !== undefined && a.estimatedRecords > BigInt(LIMITS.MAX_ESTIMATED_RECORDS)) {
      fail('VALIDATION_FAILED', 'estimatedRecords is out of range');
    }
    requireEvidenceOfIncident(ctx, a.evidenceId, incident.id);

    const scopeKey = `${incident.id}:${a.assetId}:${a.dataCategory}`;
    const existing = ctx.db.dataScope.scopeKey.find(scopeKey);
    const fields = {
      sensitivity: a.sensitivity,
      lockStatus: a.lockStatus,
      exfiltrationStatus: a.exfiltrationStatus,
      integrityStatus: a.integrityStatus,
      estimatedRecords: a.estimatedRecords,
      confidence: a.confidence,
      evidenceId: a.evidenceId,
      updatedBy: ctx.sender,
      updatedAt: ctx.timestamp,
    };
    let id: string;
    if (existing) {
      id = existing.id;
      ctx.db.dataScope.id.update({ ...existing, ...fields, version: existing.version + 1 });
    } else {
      id = newId(ctx);
      ctx.db.dataScope.insert({
        id,
        organizationId: incident.organizationId,
        incidentId: incident.id,
        assetId: a.assetId,
        dataCategory: a.dataCategory,
        createdAt: ctx.timestamp,
        version: 1,
        scopeKey,
        ...fields,
      });
    }
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: 'DATA_SCOPE_UPDATED',
      targetId: id,
      metadata: {
        lockStatus: a.lockStatus,
        exfiltrationStatus: a.exfiltrationStatus,
        integrityStatus: a.integrityStatus,
        previousExfiltrationStatus: existing?.exfiltrationStatus ?? null,
      },
    });
  }
);
