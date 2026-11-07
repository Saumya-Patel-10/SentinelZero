import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    stdbUri: string;
    dbName: string;
    adminToken: string;
  }
}

/**
 * Builds the module with the pinned CLI, mints a throwaway identity on the local server, and
 * publishes a fresh database AS that identity (so it becomes the platform admin via `init`).
 * No CLI credentials are read. Tokens are never printed.
 *
 * Env:
 *   SPACETIME_CLI   path to the pinned spacetime CLI 2.14.1 (default: `spacetime` on PATH)
 *   SZ_STDB_URI     server URL (default http://127.0.0.1:3000)
 *   SZ_TEST_DB      database name prefix (default sentinelzero-test); a unique suffix is added per run
 */
export default async function setup(project: TestProject) {
  const cli = process.env.SPACETIME_CLI ?? 'spacetime';
  const stdbUri = process.env.SZ_STDB_URI ?? 'http://127.0.0.1:3000';
  const dbName = `${process.env.SZ_TEST_DB ?? 'sentinelzero-test'}-${Date.now().toString(36)}`;
  const modulePath = fileURLToPath(new URL('../..', import.meta.url));

  execFileSync(cli, ['build', '--module-path', modulePath], { stdio: ['ignore', 'ignore', 'inherit'] });
  const bundle = readFileSync(join(modulePath, 'dist', 'bundle.js'));

  const idRes = await fetch(`${stdbUri}/v1/identity`, { method: 'POST' });
  if (!idRes.ok) throw new Error(`identity mint failed: HTTP ${idRes.status}`);
  const { token: adminToken } = (await idRes.json()) as { token: string };

  const pubRes = await fetch(`${stdbUri}/v1/database/${dbName}?clear=true&host_type=Js`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/octet-stream' },
    body: bundle,
  });
  if (!pubRes.ok) throw new Error(`publish failed: HTTP ${pubRes.status} ${await pubRes.text()}`);

  project.provide('stdbUri', stdbUri);
  project.provide('dbName', dbName);
  project.provide('adminToken', adminToken);

  return async () => {
    await fetch(`${stdbUri}/v1/database/${dbName}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
  };
}
