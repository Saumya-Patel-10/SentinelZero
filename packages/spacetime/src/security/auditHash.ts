import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

// Dependency-free (no SpacetimeDB runtime imports) so clients and tests can verify the chain.

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export function computeAuditHash(fields: {
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
}): string {
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
