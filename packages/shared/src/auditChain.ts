import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

// Canonical audit hash chain, shared by the SpacetimeDB module (writer) and every verifier
// (browser, tests, scripts). Imported via the `@sentinelzero/shared/audit` subpath so the main
// shared entry point stays dependency-free.
//
// GUARANTEE (read before displaying any badge): the chain is tamper-EVIDENT, not immutable.
// It detects edits, deletions, insertions and reordering of audit rows made without recomputing
// every later hash. Anyone with database-owner access can rewrite rows AND recompute the chain;
// only comparison against a previously recorded `pin` (or an external anchor, not implemented)
// detects that.

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export interface AuditHashFields {
  organizationId: string;
  incidentId: string;
  seq: bigint;
  actorHex: string;
  actorKind: string;
  eventType: string;
  targetId: string;
  timestampMicros: bigint;
  metadata: string;
  previousHash: string;
}

export function computeAuditHash(fields: AuditHashFields): string {
  const canonical = [
    fields.organizationId,
    fields.incidentId,
    fields.seq.toString(),
    fields.actorHex,
    fields.actorKind,
    fields.eventType,
    fields.targetId,
    fields.timestampMicros.toString(),
    fields.metadata,
    fields.previousHash,
  ].join('\n');
  return bytesToHex(sha256(utf8ToBytes(canonical)));
}

/** Structural shape of a `my_audit_events` row; generated binding rows satisfy it directly. */
export interface AuditEventLike {
  id: string;
  organizationId: string;
  incidentId: string;
  seq: bigint;
  actorIdentity: { toHexString(): string };
  actorKind: string;
  eventType: string;
  targetId: string;
  timestamp: { microsSinceUnixEpoch: bigint };
  metadata: string;
  previousHash: string;
  eventHash: string;
}

/** Shape of a `my_audit_chain_heads` row. */
export interface AuditChainHeadLike {
  organizationId: string;
  seq: bigint;
  lastHash: string;
}

export type AuditChainStatus = 'VERIFIED' | 'BROKEN' | 'EMPTY';

export type AuditChainFailureReason =
  | 'GENESIS_MISMATCH'
  | 'SEQ_GAP'
  | 'DUPLICATE_SEQ'
  | 'LINK_MISMATCH'
  | 'HASH_MISMATCH'
  | 'HEAD_MISMATCH'
  | 'PIN_MISMATCH';

export interface AuditChainVerification {
  status: AuditChainStatus;
  organizationId: string;
  /** Number of events whose hash was recomputed and linked. */
  checkedCount: number;
  /** Last verified seq/hash (0n / genesis when none). Store this as the next `pin`. */
  lastSeq: bigint;
  lastHash: string;
  /** true when a server head was supplied and compared (detects tail truncation vs. the head). */
  headChecked: boolean;
  /** true when a client-recorded pin was supplied and compared (detects rewrite since the pin). */
  pinChecked: boolean;
  failure?: { reason: AuditChainFailureReason; seq: bigint; eventId: string; detail: string };
}

export interface VerifyAuditChainOptions {
  /** Current server head for this organization, from `my_audit_chain_heads`. */
  head?: AuditChainHeadLike;
  /** A {seq, hash} pair this client verified earlier. The chain must still contain it unchanged. */
  pin?: { seq: bigint; hash: string };
}

/**
 * Recomputes and links every audit event of one organization, starting at the genesis hash.
 * Pure and synchronous: pass the rows you hold; nothing is fetched or trusted from a badge.
 */
export function verifyAuditChain(
  organizationId: string,
  events: Iterable<AuditEventLike>,
  options: VerifyAuditChainOptions = {}
): AuditChainVerification {
  const rows = [...events].filter(e => e.organizationId === organizationId).sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  const result: AuditChainVerification = {
    status: 'VERIFIED',
    organizationId,
    checkedCount: 0,
    lastSeq: 0n,
    lastHash: AUDIT_GENESIS_HASH,
    headChecked: options.head !== undefined,
    pinChecked: options.pin !== undefined,
  };
  const broken = (reason: AuditChainFailureReason, seq: bigint, eventId: string, detail: string) => {
    result.status = 'BROKEN';
    result.failure = { reason, seq, eventId, detail };
    return result;
  };

  let expectedSeq = 1n;
  let previousHash = AUDIT_GENESIS_HASH;
  let pinSeen = false;
  for (const e of rows) {
    if (e.seq < expectedSeq) return broken('DUPLICATE_SEQ', e.seq, e.id, `seq ${e.seq} appears more than once`);
    if (e.seq > expectedSeq) {
      return expectedSeq === 1n
        ? broken('GENESIS_MISMATCH', e.seq, e.id, `chain starts at seq ${e.seq}, expected 1`)
        : broken('SEQ_GAP', e.seq, e.id, `missing seq ${expectedSeq}..${e.seq - 1n}`);
    }
    if (e.previousHash !== previousHash) {
      return expectedSeq === 1n
        ? broken('GENESIS_MISMATCH', e.seq, e.id, 'first event does not link to the genesis hash')
        : broken('LINK_MISMATCH', e.seq, e.id, `previousHash does not equal the hash of seq ${e.seq - 1n}`);
    }
    const recomputed = computeAuditHash({
      organizationId: e.organizationId,
      incidentId: e.incidentId,
      seq: e.seq,
      actorHex: e.actorIdentity.toHexString(),
      actorKind: e.actorKind,
      eventType: e.eventType,
      targetId: e.targetId,
      timestampMicros: e.timestamp.microsSinceUnixEpoch,
      metadata: e.metadata,
      previousHash: e.previousHash,
    });
    if (recomputed !== e.eventHash) return broken('HASH_MISMATCH', e.seq, e.id, 'stored eventHash does not match the recomputed hash');
    if (options.pin && e.seq === options.pin.seq) {
      if (e.eventHash !== options.pin.hash) return broken('PIN_MISMATCH', e.seq, e.id, 'event at the pinned seq has a different hash');
      pinSeen = true;
    }
    previousHash = e.eventHash;
    result.checkedCount++;
    result.lastSeq = e.seq;
    result.lastHash = e.eventHash;
    expectedSeq++;
  }

  if (options.pin && options.pin.seq > 0n && !pinSeen) {
    return broken('PIN_MISMATCH', options.pin.seq, '', `chain ends at seq ${result.lastSeq}, before the pinned seq ${options.pin.seq}`);
  }
  if (options.head) {
    const h = options.head;
    if (h.seq !== result.lastSeq || h.lastHash !== result.lastHash) {
      return broken('HEAD_MISMATCH', h.seq, '', `server head is seq ${h.seq}; verified events end at seq ${result.lastSeq}`);
    }
  }
  if (rows.length === 0) result.status = 'EMPTY';
  return result;
}
