import { t } from 'spacetimedb/server';
import spacetimedb, { auditChainHead } from '../schema';
import { orgsWithCapability } from '../security/membership';
import { incidentScoped } from './scope';
import { CONTRACT_VERSION } from '../../../shared/src/contract';

const BackendInfo = t.row('BackendInfoRow', {
  contractVersion: t.string().primaryKey(),
  /** false = OPEN development mode: any token the host accepts may connect. */
  issuerPolicyEnforced: t.bool(),
  trustedIssuerCount: t.u32(),
});

/** Same row for every caller, including unauthenticated ones. Discloses no tenant data. */
export const backend_info = spacetimedb.anonymousView({ name: 'backend_info', public: true }, t.array(BackendInfo), ctx => {
  const count = Number(ctx.db.trustedIssuer.count());
  return [{ contractVersion: CONTRACT_VERSION, issuerPolicyEnforced: count > 0, trustedIssuerCount: count }];
});

/** Current audit chain head per organization, for verifyAuditChain(..., { head }). OWNER/COMMANDER/ANALYST. */
export const my_audit_chain_heads = spacetimedb.view({ name: 'my_audit_chain_heads', public: true }, t.array(auditChainHead.rowType), ctx =>
  orgsWithCapability(ctx.db, ctx.sender, 'VIEW_AUDIT').flatMap(orgId => {
    const head = ctx.db.auditChainHead.organizationId.find(orgId);
    return head ? [head] : [];
  })
);

const TimelineEntry = t.row('TimelineEntry', {
  id: t.string().primaryKey(),
  organizationId: t.string(),
  incidentId: t.string(),
  seq: t.u64(),
  actorIdentity: t.identity(),
  actorKind: t.string(),
  eventType: t.string(),
  targetId: t.string(),
  timestamp: t.timestamp(),
});

/**
 * Incident-scoped activity timeline for every detail-level role, RESPONDER included. Projects audit
 * events WITHOUT metadata or hashes (reasons, notes and identifiers in metadata stay O/C/A-only).
 */
export const my_incident_timeline = spacetimedb.view({ name: 'my_incident_timeline', public: true }, t.array(TimelineEntry), ctx =>
  incidentScoped(ctx.db, ctx.sender, 'VIEW_INCIDENT_DETAIL', incidentId =>
    [...ctx.db.auditEvent.incidentId.filter(incidentId)].map(e => ({
      id: e.id,
      organizationId: e.organizationId,
      incidentId: e.incidentId,
      seq: e.seq,
      actorIdentity: e.actorIdentity,
      actorKind: e.actorKind,
      eventType: e.eventType,
      targetId: e.targetId,
      timestamp: e.timestamp,
    }))
  )
);
