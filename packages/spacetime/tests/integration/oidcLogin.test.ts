import { afterAll, describe, expect, it } from 'vitest';
import { Identity } from 'spacetimedb';
import { adminActor, connect, disconnectAll, httpCall, httpSql, mintToken, stdbUri, subscribe, waitFor } from './client';
import { startTestIssuer } from './oidcIssuer';
import { createTeam } from './fixtures';
import { MAX_USER_TOKEN_LIFETIME_SECONDS } from '../../../shared/src/contract';

afterAll(() => disconnectAll());

const AUD = 'sentinelzero-web';
const nowS = () => Math.floor(Date.now() / 1000);

async function rejected(label: string, token: string): Promise<{ ws: string; http: { status: number; body: string } }> {
  let ws = '';
  try {
    await connect(label, token);
  } catch (e) {
    ws = String(e);
  }
  if (!ws) throw new Error(`${label}: WebSocket connection was accepted`);
  const http = await httpCall(token, 'register_profile', [label]);
  expect(http.status, `${label} http`).toBeGreaterThanOrEqual(400);
  return { ws, http };
}

describe('external OIDC login and issuer policy', () => {
  it('host verifies OIDC signatures via JWKS; module enforces issuer+audience on every path and expiry/lifetime on HTTP', async () => {
    const idp = await startTestIssuer();
    const admin = await adminActor();
    const team = await createTeam('oidc');
    const sp = (await (await fetch(`${stdbUri()}/v1/identity`, { method: 'POST' })).json()) as { identity: string; token: string };
    await team.owner.conn.reducers.registerServicePrincipal({ organizationId: team.orgId, identity: Identity.fromString(sp.identity), label: 'ai' });

    const userToken = (sub: string, extra: Record<string, unknown> = {}) =>
      idp.sign({ iss: idp.issuer, sub, aud: [AUD], iat: nowS(), exp: nowS() + 600, ...extra });

    // Host-level checks apply in every mode.
    const expired = await httpCall(userToken('alice', { iat: nowS() - 900, exp: nowS() - 300 }), 'register_profile', ['x']);
    expect(expired.status).toBe(401);
    const forged = await httpCall(idp.signWithRogueKey({ iss: idp.issuer, sub: 'alice', aud: [AUD], iat: nowS(), exp: nowS() + 600 }), 'register_profile', ['x']);
    expect(forged.status).toBe(401);
    expect(idp.hits).toContain('/jwks.json');

    // OPEN mode: no allowlist, so even a token without exp is accepted (documented dev-only behaviour).
    const info = await httpSql(null, 'SELECT * FROM backend_info');
    expect(JSON.parse(info.body)[0].rows).toEqual([['1.1.0', false, 0]]);
    expect((await httpCall(idp.sign({ iss: idp.issuer, sub: 'dev', aud: [AUD], iat: nowS() }), 'register_profile', ['dev'])).status).toBe(200);

    try {
      await admin.conn.reducers.addTrustedIssuer({ issuer: idp.issuer });
      await admin.conn.reducers.addTrustedAudience({ issuer: idp.issuer, audience: AUD });

      // A real login: OIDC user connects, is NOT a member yet, sees nothing, then is enrolled by the OWNER.
      const alice = await connect('alice', userToken('alice'));
      await alice.conn.reducers.registerProfile({ displayName: 'Alice (OIDC)' });
      await subscribe(alice, ['SELECT * FROM my_organizations', 'SELECT * FROM backend_info']);
      expect([...alice.conn.db.myOrganizations.iter()]).toHaveLength(0);
      expect([...alice.conn.db.backendInfo.iter()][0]).toMatchObject({ issuerPolicyEnforced: true, trustedIssuerCount: 1 });
      await team.owner.conn.reducers.inviteMember({ organizationId: team.orgId, userIdentity: alice.identity, role: 'ANALYST' });
      await waitFor('enrolled org visible', () => [...alice.conn.db.myOrganizations.iter()].find(o => o.id === team.orgId));
      // Same (iss, sub) => same identity on every login.
      expect((await connect('alice-again', userToken('alice'))).identity.isEqual(alice.identity)).toBe(true);

      // Issuer and audience: rejected on BOTH the WebSocket and the HTTP path.
      for (const [label, token] of [
        ['wrong-audience', userToken('mallory', { aud: ['spacetimedb'] })],
        ['self-minted-local', await mintToken()],
      ] as const) {
        const r = await rejected(label, token);
        expect(r.http.status, label).toBe(403);
        expect(r.http.body, label).toMatch(/AUTH_REQUIRED/);
      }
      // Expiry and lifetime: rejected on the HTTP path only. The WebSocket path sees the host's
      // re-issued 60 s token (see tokenPolicy.ts), so these connections are ACCEPTED. This pins the
      // documented 2.14.1 limitation; if it starts failing, the host behaviour changed.
      for (const [label, token, why] of [
        ['no-exp', idp.sign({ iss: idp.issuer, sub: 'mallory', aud: [AUD], iat: nowS() }), /expiry/],
        ['too-long', userToken('mallory', { exp: nowS() + MAX_USER_TOKEN_LIFETIME_SECONDS + 3600 }), /lifetime/],
      ] as const) {
        const http = await httpCall(token, 'register_profile', [label]);
        expect(http.status, label).toBe(403);
        expect(http.body, label).toMatch(/^AUTH_REQUIRED: /);
        expect(http.body, label).toMatch(why);
        expect((await connect(label, token)).identity, `${label} ws`).toBeDefined();
      }

      // Enrolled machine identities keep working with their server-minted tokens.
      expect((await adminActor()).identity).toBeDefined();
      expect((await httpCall(sp.token, 'agent_get_incident', ['no-such-run'])).status).toBe(200);

      // Platform-disabled users cannot open new sessions.
      await admin.conn.reducers.setUserDisabled({ userIdentity: alice.identity, disabled: true });
      expect((await rejected('alice-disabled', userToken('alice'))).http.body).toMatch(/account disabled/);
      await admin.conn.reducers.setUserDisabled({ userIdentity: alice.identity, disabled: false });

      // Removing the issuer removes its audiences too.
      await admin.conn.reducers.removeTrustedIssuer({ issuer: idp.issuer });
      await admin.conn.reducers.addTrustedIssuer({ issuer: idp.issuer });
      expect((await httpCall(userToken('bob', { aud: ['other-client'] }), 'register_profile', ['bob'])).status).toBe(200);
    } finally {
      await admin.conn.reducers.removeTrustedIssuer({ issuer: idp.issuer });
      await idp.close();
    }
    expect(JSON.parse((await httpSql(null, 'SELECT * FROM backend_info')).body)[0].rows).toEqual([['1.1.0', false, 0]]);
  });

  it('only platform admins manage the issuer policy', async () => {
    const team = await createTeam('oidc-admin');
    await expect(team.owner.conn.reducers.addTrustedAudience({ issuer: 'https://x.example', audience: 'a' })).rejects.toThrow(/ACCESS_DENIED/);
    await expect(team.owner.conn.reducers.removeTrustedIssuer({ issuer: 'https://x.example' })).rejects.toThrow(/ACCESS_DENIED/);
    const admin = await adminActor();
    await expect(admin.conn.reducers.addTrustedAudience({ issuer: 'https://not-added.example', audience: 'a' })).rejects.toThrow(/NOT_FOUND/);
  });
});
