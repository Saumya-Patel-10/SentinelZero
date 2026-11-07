import { inject } from 'vitest';
import type { Identity } from 'spacetimedb';
import { DbConnection } from '../../bindings';
import { parseBackendError, type ErrorCode } from '../../../shared/src/errors';

export const stdbUri = () => inject('stdbUri');
export const dbName = () => inject('dbName');

export interface Actor {
  name: string;
  token: string;
  identity: Identity;
  conn: DbConnection;
}

const open: DbConnection[] = [];

export async function mintToken(): Promise<string> {
  const res = await fetch(`${stdbUri()}/v1/identity`, { method: 'POST' });
  if (!res.ok) throw new Error(`identity mint failed: HTTP ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

export function connect(name: string, token: string): Promise<Actor> {
  return new Promise((resolve, reject) => {
    const conn = DbConnection.builder()
      .withUri(stdbUri())
      .withDatabaseName(dbName())
      .withToken(token)
      .onConnect((c, identity) => resolve({ name, token, identity, conn: c }))
      .onConnectError((_ctx, err) => reject(err))
      .build();
    open.push(conn);
  });
}

export async function newActor(name: string): Promise<Actor> {
  return connect(name, await mintToken());
}

export function adminActor(): Promise<Actor> {
  return connect('platform-admin', inject('adminToken'));
}

export function disconnectAll(): void {
  for (const c of open.splice(0)) {
    try {
      c.disconnect();
    } catch {
      // already closed
    }
  }
}

/** Subscribes and resolves once the initial snapshot is applied; rejects on subscription error. */
export function subscribe(actor: Actor, queries: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    actor.conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError(ctx => reject((ctx as { event?: unknown }).event ?? new Error('subscription error')))
      .subscribe(queries);
  });
}

export async function waitFor<T>(what: string, probe: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

/** Asserts that a reducer/procedure promise rejects with the given typed backend error code. */
export async function expectCode(p: Promise<unknown>, code: ErrorCode): Promise<string> {
  try {
    await p;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const parsed = parseBackendError(msg);
    if (parsed.code !== code) throw new Error(`expected ${code}, got: ${msg}`);
    return msg;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

export async function httpCall(token: string | null, fn: string, args: unknown[]): Promise<{ status: number; body: string }> {
  const res = await fetch(`${stdbUri()}/v1/database/${dbName()}/call/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(args),
  });
  return { status: res.status, body: await res.text() };
}

export async function httpSql(token: string | null, sql: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${stdbUri()}/v1/database/${dbName()}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: sql,
  });
  return { status: res.status, body: await res.text() };
}

let keyCounter = 0;
export function key(prefix = 'k'): string {
  keyCounter++;
  return `${prefix}-${Date.now().toString(36)}-${keyCounter}-${Math.random().toString(36).slice(2, 10)}`;
}
