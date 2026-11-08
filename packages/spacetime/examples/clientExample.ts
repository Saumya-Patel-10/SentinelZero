// Reference browser/Node client for docs/INTEGRATION_CONTRACT.md. Typechecked by tsconfig.test.json
// and executed end-to-end by tests/integration/contractExample.test.ts, so every call below is real.
//
// In apps/web, import the bindings from `packages/spacetime/bindings` (or a copy generated with
// the same 2.14.1 CLI) and the helpers from `packages/shared/src`.
import { Identity } from 'spacetimedb';
import { DbConnection, type ErrorContext, type SubscriptionHandle } from '../bindings';
import { parseBackendError, type ParsedBackendError } from '../../shared/src/errors';
import { verifyAuditChain, type AuditChainVerification } from '../../shared/src/auditChain';
import { buildImpactGraph } from '../../shared/src/graph';

export interface Session {
  conn: DbConnection;
  identity: Identity;
}

/**
 * Opens an authenticated session. `token` is the user's OIDC ID token (enforced issuer policy) or,
 * in OPEN development mode only, a server-minted token. The SDK exchanges it at
 * /v1/identity/websocket-token and opens the socket with the short-lived result.
 */
export function openSession(uri: string, databaseName: string, token: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(databaseName)
      .withToken(token)
      .onConnect((conn, identity) => resolve({ conn, identity }))
      .onConnectError((_ctx: ErrorContext, err: Error) => reject(err))
      .build();
  });
}

/** Views the command-center screens need. Subscribe once per session; filter by incident client-side. */
export const COMMAND_CENTER_QUERIES = [
  'SELECT * FROM backend_info',
  'SELECT * FROM my_profile',
  'SELECT * FROM my_memberships',
  'SELECT * FROM my_organizations',
  'SELECT * FROM org_member_directory',
  'SELECT * FROM my_incident_summaries',
  'SELECT * FROM my_incidents',
  'SELECT * FROM my_incident_timeline',
  'SELECT * FROM my_assets',
  'SELECT * FROM my_services',
  'SELECT * FROM my_service_dependencies',
  'SELECT * FROM my_operational_impacts',
  'SELECT * FROM my_data_scopes',
  'SELECT * FROM my_evidence',
  'SELECT * FROM my_tasks',
  'SELECT * FROM my_messages',
  'SELECT * FROM my_agent_runs',
  'SELECT * FROM my_agent_tool_calls',
  'SELECT * FROM my_recommendations',
  'SELECT * FROM my_audit_events',
  'SELECT * FROM my_audit_chain_heads',
] as const;

export function subscribeCommandCenter(session: Session): Promise<SubscriptionHandle> {
  return new Promise((resolve, reject) => {
    const handle: SubscriptionHandle = session.conn
      .subscriptionBuilder()
      .onApplied(() => resolve(handle))
      .onError((ctx: ErrorContext) => reject(ctx.event ?? new Error('subscription error')))
      .subscribe([...COMMAND_CENTER_QUERIES]);
  });
}

/** Reducer calls resolve after commit and reject with "<CODE>: <detail>". */
export async function attempt(p: Promise<void>): Promise<ParsedBackendError | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return parseBackendError(e instanceof Error ? e.message : String(e));
  }
}

export function newKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** Guided intake: create, then wait for the row to arrive through the subscription. */
export async function createIncident(session: Session, organizationId: string, title: string) {
  const err = await attempt(
    session.conn.reducers.createIncident({
      organizationId,
      title,
      description: 'EXERCISE: synthetic incident',
      category: 'RANSOMWARE',
      severity: 'CRITICAL',
      detectedAt: undefined,
      idempotencyKey: newKey('intake'),
    })
  );
  if (err) throw new Error(`${err.code}: ${err.detail}`);
  return waitForRow(() => [...session.conn.db.myIncidents.iter()].find(i => i.organizationId === organizationId && i.title === title));
}

/** Versioned status change. On VERSION_CONFLICT, reload the row and let the user retry. */
export function transition(session: Session, incidentId: string, expectedVersion: number, toStatus: string, reason: string) {
  return attempt(session.conn.reducers.transitionIncidentStatus({ incidentId, expectedVersion, toStatus, reason, evidenceId: '' }));
}

export function graphFor(session: Session, incidentId: string) {
  const db = session.conn.db;
  return buildImpactGraph(incidentId, {
    assets: [...db.myAssets.iter()],
    services: [...db.myServices.iter()],
    dependencies: [...db.myServiceDependencies.iter()],
    impacts: [...db.myOperationalImpacts.iter()],
  });
}

/** Audit panel: real recomputation of the per-organization chain against the server head. */
export function auditStatus(session: Session, organizationId: string, pin?: { seq: bigint; hash: string }): AuditChainVerification {
  const head = [...session.conn.db.myAuditChainHeads.iter()].find(h => h.organizationId === organizationId);
  return verifyAuditChain(organizationId, session.conn.db.myAuditEvents.iter(), { head, pin });
}

export async function waitForRow<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for subscription update');
    await new Promise(r => setTimeout(r, 25));
  }
}
