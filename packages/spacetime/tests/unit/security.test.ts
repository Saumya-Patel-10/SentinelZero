import { describe, expect, it } from 'vitest';
import { evaluateTokenPolicy, type TokenPolicyInput } from '../../src/security/tokenPolicy';
import {
  AUDIT_GENESIS_HASH,
  computeAuditHash,
  verifyAuditChain,
  type AuditEventLike,
} from '../../../shared/src/auditChain';
import { MAX_USER_TOKEN_LIFETIME_SECONDS } from '../../../shared/src/contract';

describe('token policy', () => {
  const now = 1_800_000_000;
  const base: TokenPolicyInput = {
    enforced: true,
    isEnrolledMachineIdentity: false,
    claims: { issuer: 'https://idp.example', audience: ['sentinelzero-web'], exp: now + 600, iat: now },
    issuerTrusted: true,
    allowedAudiences: ['sentinelzero-web'],
    nowSeconds: now,
  };
  const reason = (p: Partial<TokenPolicyInput>) => {
    const d = evaluateTokenPolicy({ ...base, ...p });
    return d.ok ? 'OK' : d.reason;
  };

  it('accepts a short-lived token from a trusted issuer and audience', () => {
    expect(reason({})).toBe('OK');
  });
  it('accepts anything while the policy is not enforced (OPEN development mode)', () => {
    expect(reason({ enforced: false, claims: null, issuerTrusted: false })).toBe('OK');
  });
  it('exempts enrolled machine identities (platform admin, service principals)', () => {
    expect(reason({ isEnrolledMachineIdentity: true, issuerTrusted: false, claims: { ...base.claims!, exp: undefined } })).toBe('OK');
  });
  it('rejects untrusted issuers, missing tokens and wrong audiences', () => {
    expect(reason({ issuerTrusted: false })).toMatch(/issuer/);
    expect(reason({ claims: null })).toMatch(/required/);
    expect(reason({ claims: { ...base.claims!, audience: ['spacetimedb'] } })).toMatch(/audience/);
    expect(reason({ allowedAudiences: [], claims: { ...base.claims!, audience: ['anything'] } })).toBe('OK');
  });
  it('requires a bounded expiry', () => {
    expect(reason({ claims: { ...base.claims!, exp: undefined } })).toMatch(/expiry/);
    expect(reason({ claims: { ...base.claims!, exp: '9999999999' } })).toMatch(/expiry/);
    expect(reason({ claims: { ...base.claims!, exp: now } })).toMatch(/expired/);
    expect(reason({ claims: { ...base.claims!, exp: now + MAX_USER_TOKEN_LIFETIME_SECONDS + 1 } })).toMatch(/lifetime/);
    expect(reason({ claims: { ...base.claims!, iat: now - MAX_USER_TOKEN_LIFETIME_SECONDS, exp: now + 60 } })).toMatch(/lifetime/);
    expect(reason({ claims: { ...base.claims!, iat: undefined, exp: now + 60 } })).toBe('OK');
  });
});

describe('audit chain verifier', () => {
  const ORG = 'org-1';
  const actor = { toHexString: () => 'c200aa' };

  function chain(n: number, org = ORG): AuditEventLike[] {
    const out: AuditEventLike[] = [];
    let prev = AUDIT_GENESIS_HASH;
    for (let i = 1; i <= n; i++) {
      const seq = BigInt(i);
      const e = {
        id: `e${i}`,
        organizationId: org,
        incidentId: i % 2 ? 'inc-1' : '',
        seq,
        actorIdentity: actor,
        actorKind: 'USER',
        eventType: `EVENT_${i}`,
        targetId: `t${i}`,
        timestamp: { microsSinceUnixEpoch: 1_000n + seq },
        metadata: JSON.stringify({ i }),
        previousHash: prev,
        eventHash: '',
      };
      e.eventHash = computeAuditHash({ ...e, actorHex: actor.toHexString(), timestampMicros: e.timestamp.microsSinceUnixEpoch });
      prev = e.eventHash;
      out.push(e);
    }
    return out;
  }
  const rehash = (e: AuditEventLike) => ({
    ...e,
    eventHash: computeAuditHash({ ...e, actorHex: e.actorIdentity.toHexString(), timestampMicros: e.timestamp.microsSinceUnixEpoch }),
  });

  it('verifies an intact chain in any input order and reports the tip', () => {
    const events = chain(5);
    const r = verifyAuditChain(ORG, [...events].reverse(), { head: { organizationId: ORG, seq: 5n, lastHash: events[4].eventHash } });
    expect(r).toMatchObject({ status: 'VERIFIED', checkedCount: 5, lastSeq: 5n, lastHash: events[4].eventHash, headChecked: true });
    expect(r.failure).toBeUndefined();
  });

  it('reports EMPTY rather than VERIFIED when there is nothing to check', () => {
    expect(verifyAuditChain(ORG, []).status).toBe('EMPTY');
    expect(verifyAuditChain(ORG, chain(3, 'other-org')).status).toBe('EMPTY');
  });

  it('detects edited content (HASH_MISMATCH)', () => {
    const events = chain(4);
    events[2] = { ...events[2], metadata: '{"i":"tampered"}' };
    expect(verifyAuditChain(ORG, events).failure).toMatchObject({ reason: 'HASH_MISMATCH', seq: 3n });
  });

  it('detects an edited row whose own hash was recomputed (LINK_MISMATCH on the next row)', () => {
    const events = chain(4);
    events[1] = rehash({ ...events[1], eventType: 'FORGED' });
    expect(verifyAuditChain(ORG, events).failure).toMatchObject({ reason: 'LINK_MISMATCH', seq: 3n });
  });

  it('detects deleted, duplicated and missing-genesis rows', () => {
    const events = chain(5);
    expect(verifyAuditChain(ORG, events.filter(e => e.seq !== 3n)).failure?.reason).toBe('SEQ_GAP');
    expect(verifyAuditChain(ORG, [...events, { ...events[2], id: 'dup' }]).failure?.reason).toBe('DUPLICATE_SEQ');
    expect(verifyAuditChain(ORG, events.slice(1)).failure?.reason).toBe('GENESIS_MISMATCH');
    const badGenesis = chain(1);
    badGenesis[0] = rehash({ ...badGenesis[0], previousHash: 'f'.repeat(64) });
    expect(verifyAuditChain(ORG, badGenesis).failure?.reason).toBe('GENESIS_MISMATCH');
  });

  it('detects tail truncation only when compared against the head', () => {
    const events = chain(5);
    const truncated = events.slice(0, 3);
    expect(verifyAuditChain(ORG, truncated).status).toBe('VERIFIED');
    const r = verifyAuditChain(ORG, truncated, { head: { organizationId: ORG, seq: 5n, lastHash: events[4].eventHash } });
    expect(r.failure?.reason).toBe('HEAD_MISMATCH');
  });

  it('detects a fully recomputed rewrite only against a previously recorded pin', () => {
    const original = chain(4);
    const pin = { seq: 3n, hash: original[2].eventHash };
    // An attacker with owner access rewrites seq 2 and recomputes every later hash and the head.
    const rewritten: AuditEventLike[] = [];
    let prev = AUDIT_GENESIS_HASH;
    for (const e of original) {
      const next = rehash({ ...e, previousHash: prev, eventType: e.seq === 2n ? 'FORGED' : e.eventType });
      rewritten.push(next);
      prev = next.eventHash;
    }
    const head = { organizationId: ORG, seq: 4n, lastHash: prev };
    expect(verifyAuditChain(ORG, rewritten, { head }).status).toBe('VERIFIED');
    expect(verifyAuditChain(ORG, rewritten, { head, pin }).failure?.reason).toBe('PIN_MISMATCH');
    expect(verifyAuditChain(ORG, original.slice(0, 2), { pin }).failure?.reason).toBe('PIN_MISMATCH');
    expect(verifyAuditChain(ORG, original, { pin })).toMatchObject({ status: 'VERIFIED', pinChecked: true });
  });
});
