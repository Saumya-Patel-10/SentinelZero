import { MAX_USER_TOKEN_LIFETIME_SECONDS } from '../../../shared/src/contract';

// Pure (no SpacetimeDB runtime imports) so unit tests can exercise every branch.
//
// The SpacetimeDB 2.14.1 host verifies the token signature against the issuer's OIDC JWKS and
// rejects an `exp` in the past, but it accepts tokens WITHOUT `exp` and never checks `aud`
// (verified by tests/integration/oidcLogin.test.ts). This policy closes those gaps once a
// platform admin has configured at least one trusted issuer.
//
// LIMITATION: WebSocket clients first exchange their token at /v1/identity/websocket-token for a
// host-signed token that keeps iss/sub/aud but carries a fresh 60 s iat/exp. Issuer and audience
// are therefore enforced on both paths, while the exp/lifetime rules only bind HTTP calls.

export interface TokenPolicyInput {
  /** At least one trusted_issuer row exists. */
  enforced: boolean;
  /** Platform admin or active service principal: provisioned machine identities, exempt from the issuer allowlist. */
  isEnrolledMachineIdentity: boolean;
  /** null when the caller presented no JWT. */
  claims: { issuer: string; audience: readonly string[]; exp: unknown; iat: unknown } | null;
  issuerTrusted: boolean;
  /** Configured audiences for the caller's issuer (empty = any audience accepted for that issuer). */
  allowedAudiences: readonly string[];
  nowSeconds: number;
}

export type TokenPolicyDecision = { ok: true } | { ok: false; reason: string };

export function evaluateTokenPolicy(p: TokenPolicyInput): TokenPolicyDecision {
  if (!p.enforced) return { ok: true };
  if (p.isEnrolledMachineIdentity) return { ok: true };
  if (!p.claims) return { ok: false, reason: 'a token from a trusted issuer is required' };
  if (!p.issuerTrusted) return { ok: false, reason: 'token issuer is not trusted' };
  if (p.allowedAudiences.length > 0 && !p.claims.audience.some(a => p.allowedAudiences.includes(a))) {
    return { ok: false, reason: 'token audience is not accepted' };
  }
  const exp = p.claims.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return { ok: false, reason: 'token must carry an expiry (exp)' };
  if (exp <= p.nowSeconds) return { ok: false, reason: 'token has expired' };
  const iat = typeof p.claims.iat === 'number' && Number.isFinite(p.claims.iat) ? p.claims.iat : p.nowSeconds;
  if (exp - iat > MAX_USER_TOKEN_LIFETIME_SECONDS || exp - p.nowSeconds > MAX_USER_TOKEN_LIFETIME_SECONDS) {
    return { ok: false, reason: `token lifetime exceeds ${MAX_USER_TOKEN_LIFETIME_SECONDS} seconds` };
  }
  return { ok: true };
}
