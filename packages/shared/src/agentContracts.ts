// AI service <-> SpacetimeDB HTTP contract. FROZEN v1.
//
// The AI service (FastAPI) calls `POST {STDB_URI}/v1/database/{DB}/call/{name}` with
// `Authorization: Bearer <token>` and a JSON body (positional array OR named object of args).
//   * Reducers return HTTP 200 with an empty body on success.
//   * Reducer failures return HTTP 530 whose body is the error text "<CODE>: <detail>" (errors.ts).
//   * Procedures return HTTP 200 with POSITIONAL JSON (product values are arrays in the field
//     order below; arrays of products are arrays of arrays).
//   * agent_get_* tool procedures wrap their value in a result sum type, also HTTP 200:
//       [0, <value>]                 success
//       [1, "<CODE>: <detail>"]      typed denial/failure (no data returned, transaction rolled back)
//   * verify_agent_run_access is NOT wrapped; unauthorized callers get authorized=false.
//   * 400 means malformed arguments (plain-text body, a client bug). Any other non-2xx (e.g. 500
//     for unexpected host failures) must be treated as SERVICE_UNAVAILABLE.
//   * Identity arguments are one-element arrays: ["0x<64 hex>"]; options are {"some": v} | {"none": []}.
// Verified against SpacetimeDB 2.14.1 by tests/integration/agentAccess.test.ts.

export const AGENT_PROCEDURE_FIELDS = {
  RunAccess: ['authorized', 'isRequester', 'role', 'runId', 'incidentId', 'organizationId', 'status'],
  AgentIncident: [
    'runId',
    'analysisType',
    'incidentId',
    'title',
    'description',
    'category',
    'severity',
    'status',
    'dataClass',
    'reportedAt',
    'detectedAt',
    'updatedAt',
  ],
  AgentAsset: ['id', 'name', 'assetType', 'criticality', 'compromiseStatus', 'availabilityStatus', 'lastVerifiedAt', 'dataScopes'],
  AgentDataScope: [
    'id',
    'dataCategory',
    'sensitivity',
    'lockStatus',
    'exfiltrationStatus',
    'integrityStatus',
    'estimatedRecords',
    'confidence',
    'evidenceId',
  ],
  AgentDependencyGraph: ['services', 'dependencies', 'impacts'],
  AgentService: ['id', 'name', 'criticality', 'availabilityStatus', 'availabilityVerification'],
  AgentDependency: ['id', 'sourceAssetId', 'targetServiceId', 'dependencyType', 'verification'],
  AgentImpact: ['id', 'serviceId', 'impactType', 'severity', 'verification', 'affectedGroup', 'description'],
  AgentTask: ['id', 'title', 'priority', 'status', 'approvalStatus', 'source', 'assigned'],
  AgentEvidence: ['id', 'evidenceType', 'source', 'sha256', 'classification', 'description', 'recordedAt'],
} as const;

/** Endpoints callable with the END USER's token (forwarded by FastAPI, never logged). */
export const USER_TOKEN_CALLS = {
  verify_agent_run_access: { args: ['runId'], returns: 'RunAccess' },
} as const;

/** Endpoints callable only with the AI SERVICE PRINCIPAL's token. */
export const SERVICE_TOKEN_CALLS = {
  agent_claim_run: { kind: 'reducer', args: ['runId', 'modelIdentifier', 'inferenceMode'] },
  agent_get_incident: { kind: 'procedure', args: ['runId'], returns: 'AgentIncident', tool: 'get_incident' },
  agent_get_assets: { kind: 'procedure', args: ['runId'], returns: 'AgentAsset[]', tool: 'get_assets' },
  agent_get_dependencies: { kind: 'procedure', args: ['runId'], returns: 'AgentDependencyGraph', tool: 'get_dependencies' },
  agent_get_open_tasks: { kind: 'procedure', args: ['runId'], returns: 'AgentTask[]', tool: 'get_open_tasks' },
  agent_get_evidence_summaries: { kind: 'procedure', args: ['runId'], returns: 'AgentEvidence[]', tool: 'get_evidence_summaries' },
  agent_submit_recommendation: {
    kind: 'reducer',
    tool: 'propose_task',
    args: ['runId', 'clientKey', 'title', 'description', 'priority', 'rationale', 'evidenceIds', 'uncertainties'],
  },
  agent_complete_run: { kind: 'reducer', args: ['runId', 'status', 'errorCategory', 'summary'] },
} as const;

type FieldMap = typeof AGENT_PROCEDURE_FIELDS;
export type AgentRecordName = keyof FieldMap;

const NESTED: Partial<Record<AgentRecordName, Record<string, AgentRecordName>>> = {
  AgentAsset: { dataScopes: 'AgentDataScope' },
  AgentDependencyGraph: { services: 'AgentService', dependencies: 'AgentDependency', impacts: 'AgentImpact' },
};

/** Decodes the `[tag, value]` result envelope used by agent_get_* procedures. */
export function decodeResult<T = unknown>(value: unknown): { ok: true; value: T } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length !== 2 || (value[0] !== 0 && value[0] !== 1)) {
    throw new Error('expected [tag, value] result envelope');
  }
  return value[0] === 0 ? { ok: true, value: value[1] as T } : { ok: false, error: String(value[1]) };
}

/** Reference decoder (the Python service should mirror this). */
export function decodePositional(record: AgentRecordName, value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) throw new Error(`${record}: expected positional array`);
  const fields = AGENT_PROCEDURE_FIELDS[record];
  if (value.length !== fields.length) throw new Error(`${record}: expected ${fields.length} fields, got ${value.length}`);
  const out: Record<string, unknown> = {};
  fields.forEach((f, i) => {
    const nested = NESTED[record]?.[f];
    out[f] = nested ? (value[i] as unknown[]).map(v => decodePositional(nested, v)) : value[i];
  });
  return out;
}
