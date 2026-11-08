import { afterAll, describe, expect, it } from 'vitest';
import { adminActor, connect, disconnectAll, expectCode, httpCall, mintToken, newActor } from './client';

afterAll(() => disconnectAll());

const issuerOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).iss as string;

describe('trusted issuer allowlist', () => {
  it('rejects connections from untrusted issuers once an allowlist is configured', async () => {
    const admin = await adminActor();
    const someone = await newActor('someone');
    await expectCode(someone.conn.reducers.addTrustedIssuer({ issuer: 'https://evil.example' }), 'ACCESS_DENIED');

    const localIssuer = issuerOf(await mintToken());
    try {
      await admin.conn.reducers.addTrustedIssuer({ issuer: 'https://idp.sentinelzero.invalid' });
      // Local-server tokens are now from an untrusted issuer.
      await expect(connect('blocked', await mintToken())).rejects.toBeDefined();
      const http = await httpCall(await mintToken(), 'register_profile', ['blocked user']);
      expect(http.status).toBeGreaterThanOrEqual(400);

      // Trusting the server's own issuer re-admits self-minted identities over WebSocket (the host
      // re-issues them with a 60 s exp); only HTTP calls see the missing `exp`. Never trust the
      // server's own issuer in a deployment.
      await admin.conn.reducers.addTrustedIssuer({ issuer: localIssuer });
      const noExp = await httpCall(await mintToken(), 'register_profile', ['no exp']);
      expect(noExp.body).toMatch(/^AUTH_REQUIRED: token must carry an expiry/);
      expect((await connect('ws-reissued', await mintToken())).identity).toBeDefined();
      // The platform admin's own server-minted identity is exempt and can still connect.
      expect((await adminActor()).identity).toBeDefined();
    } finally {
      await admin.conn.reducers.removeTrustedIssuer({ issuer: 'https://idp.sentinelzero.invalid' });
      await admin.conn.reducers.removeTrustedIssuer({ issuer: localIssuer });
    }
    await connect('after-cleanup', await mintToken());
  });
});
