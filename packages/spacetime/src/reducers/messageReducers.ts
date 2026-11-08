import { t } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { newId } from '../security/context';
import { appendAudit } from '../security/audit';
import { requireIncidentCapability } from '../security/membership';
import { consumeRateLimit } from '../security/rateLimit';
import { idempotencyKey, oneOf, requireOpenIncident, sha256Hex, text } from '../security/validation';
import { EVIDENCE_CLASSIFICATIONS, EVIDENCE_TYPES } from '../../../shared/src/enums';
import { LIMITS } from '../../../shared/src/limits';

/** Content is stored verbatim; clients MUST render it as text (never as HTML). */
export const send_message = spacetimedb.reducer(
  { incidentId: t.string(), content: t.string(), clientMessageId: t.string() },
  (ctx, a) => {
    const { incident } = requireIncidentCapability(ctx, a.incidentId, 'SEND_MESSAGE');
    text('content', a.content, LIMITS.MESSAGE);
    idempotencyKey('clientMessageId', a.clientMessageId);
    const dedupeKey = `${ctx.sender.toHexString()}:${a.clientMessageId}`;
    if (ctx.db.message.dedupeKey.find(dedupeKey)) return; // idempotent resend after reconnect
    requireOpenIncident(incident.status);
    consumeRateLimit(ctx, 'send_message');
    const id = newId(ctx);
    ctx.db.message.insert({
      id,
      organizationId: incident.organizationId,
      incidentId: incident.id,
      senderIdentity: ctx.sender,
      content: a.content,
      createdAt: ctx.timestamp,
      dedupeKey,
    });
    // Audit records the fact of a message, never its content.
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: 'MESSAGE_SENT',
      targetId: id,
      metadata: { length: a.content.length },
    });
  }
);

/** Append-only: there is intentionally no update or delete reducer for evidence references. */
export const append_evidence_reference = spacetimedb.reducer(
  {
    incidentId: t.string(),
    evidenceType: t.string(),
    source: t.string(),
    sha256: t.string(),
    classification: t.string(),
    description: t.string(),
  },
  (ctx, a) => {
    const { incident } = requireIncidentCapability(ctx, a.incidentId, 'APPEND_EVIDENCE');
    requireOpenIncident(incident.status);
    oneOf('evidenceType', EVIDENCE_TYPES, a.evidenceType);
    text('source', a.source, LIMITS.EVIDENCE_SOURCE);
    sha256Hex('sha256', a.sha256);
    oneOf('classification', EVIDENCE_CLASSIFICATIONS, a.classification);
    text('description', a.description, LIMITS.DESCRIPTION);
    consumeRateLimit(ctx, 'incident_write');
    const id = newId(ctx);
    ctx.db.evidenceReference.insert({
      id,
      organizationId: incident.organizationId,
      incidentId: incident.id,
      evidenceType: a.evidenceType,
      source: a.source,
      sha256: a.sha256,
      classification: a.classification,
      description: a.description,
      recordedBy: ctx.sender,
      recordedAt: ctx.timestamp,
    });
    appendAudit(ctx, {
      organizationId: incident.organizationId,
      incidentId: incident.id,
      actorKind: 'USER',
      eventType: 'EVIDENCE_APPENDED',
      targetId: id,
      metadata: { evidenceType: a.evidenceType, sha256: a.sha256, classification: a.classification },
    });
  }
);
