import { newId, type Ctx } from './context';
import { AUDIT_GENESIS_HASH, computeAuditHash } from './auditHash';

export type ActorKind = 'USER' | 'SERVICE' | 'PLATFORM';

export interface AuditInput {
  organizationId: string;
  incidentId?: string;
  actorKind: ActorKind;
  eventType: string;
  targetId: string;
  /** Small structured context. NEVER include message bodies, tokens, or secrets. */
  metadata?: Record<string, string | number | boolean | null>;
}

/**
 * Appends a per-organization hash-chained audit event in the same transaction as the change.
 * Tamper-EVIDENT against non-owner clients only: the database owner can rewrite rows and the
 * chain. Immutability would require external anchoring (not implemented).
 */
export function appendAudit(ctx: Ctx, input: AuditInput): void {
  const head = ctx.db.auditChainHead.organizationId.find(input.organizationId);
  const seq = (head?.seq ?? 0n) + 1n;
  const previousHash = head?.lastHash ?? AUDIT_GENESIS_HASH;
  const metadata = JSON.stringify(input.metadata ?? {});
  const incidentId = input.incidentId ?? '';
  const eventHash = computeAuditHash({
    organizationId: input.organizationId,
    incidentId,
    seq,
    actorHex: ctx.sender.toHexString(),
    actorKind: input.actorKind,
    eventType: input.eventType,
    targetId: input.targetId,
    timestampMicros: ctx.timestamp.microsSinceUnixEpoch,
    metadata,
    previousHash,
  });

  ctx.db.auditEvent.insert({
    id: newId(ctx),
    organizationId: input.organizationId,
    incidentId,
    seq,
    actorIdentity: ctx.sender,
    actorKind: input.actorKind,
    eventType: input.eventType,
    targetId: input.targetId,
    timestamp: ctx.timestamp,
    metadata,
    previousHash,
    eventHash,
  });

  if (head) {
    ctx.db.auditChainHead.organizationId.update({ organizationId: input.organizationId, seq, lastHash: eventHash });
  } else {
    ctx.db.auditChainHead.insert({ organizationId: input.organizationId, seq, lastHash: eventHash });
  }
}
