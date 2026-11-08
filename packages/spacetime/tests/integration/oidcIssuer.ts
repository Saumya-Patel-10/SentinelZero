import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * Minimal in-process OpenID Connect issuer for tests: serves discovery + JWKS on 127.0.0.1 and
 * signs RS256 ID tokens. It exists only so tests can prove how the SpacetimeDB host and the
 * module treat externally issued tokens. It is NOT an identity provider for any deployment.
 */
export interface TestIssuer {
  issuer: string;
  sign(claims: Record<string, unknown>): string;
  /** Signs with a key that is NOT published in the JWKS. */
  signWithRogueKey(claims: Record<string, unknown>): string;
  hits: string[];
  close(): Promise<void>;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function signJwt(key: crypto.KeyObject, kid: string, claims: Record<string, unknown>): string {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid });
  const body = b64(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

export async function startTestIssuer(): Promise<TestIssuer> {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogue = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'sz-test-1', alg: 'RS256', use: 'sig' };
  const hits: string[] = [];
  let issuer = '';
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') {
      res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks.json`, id_token_signing_alg_values_supported: ['RS256'] }));
    } else if (req.url === '/jwks.json') {
      res.end(JSON.stringify({ keys: [jwk] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    hits,
    sign: claims => signJwt(privateKey, 'sz-test-1', claims),
    signWithRogueKey: claims => signJwt(rogue.privateKey, 'sz-test-1', claims),
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}
