import { createHmac } from "node:crypto";

/** E2E-only HS256 helper. Mirrors services/ai/app/auth.py mint_test_token. */
export const E2E_SECRET =
  process.env.AI_E2E_JWT_SECRET ?? "e2e-only-secret-" + "x".repeat(40);

const b64url = (value: Buffer | string): string =>
  Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

export interface TokenOptions {
  subject?: string;
  organizationId?: string;
  roles?: string[];
  issuer?: string;
  audience?: string;
  ttlSeconds?: number;
  secret?: string;
}

export function mintToken(options: TokenOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: options.subject ?? "analyst@riverbend.exercise.invalid",
    org_id: options.organizationId ?? "org_riverbend_001",
    roles: options.roles ?? ["ANALYST"],
    iss: options.issuer ?? "sentinelzero-auth",
    aud: options.audience ?? "sentinelzero-ai",
    iat: now,
    exp: now + (options.ttlSeconds ?? 900),
    jti: `e2e-${now}`,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", options.secret ?? E2E_SECRET)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

export function authHeaders(options: TokenOptions = {}): Record<string, string> {
  return { Authorization: `Bearer ${mintToken(options)}` };
}
