// Server-enforced input bounds. FROZEN v1. Lengths are in UTF-16 code units (JS string length).
export const LIMITS = {
  ORG_NAME: { min: 2, max: 120 },
  DISPLAY_NAME: { min: 1, max: 80 },
  TITLE: { min: 3, max: 200 },
  DESCRIPTION: { min: 0, max: 5000 },
  SHORT_TEXT: { min: 1, max: 200 },
  REASON: { min: 3, max: 1000 },
  MESSAGE: { min: 1, max: 4000 },
  IDEMPOTENCY_KEY: { min: 8, max: 128 },
  EVIDENCE_SOURCE: { min: 1, max: 500 },
  RATIONALE: { min: 10, max: 4000 },
  TOOL_SUMMARY: { min: 0, max: 2000 },
  LIST_ITEM: { min: 1, max: 500 },
  MAX_LIST_ITEMS: 20,
  MAX_ESTIMATED_RECORDS: 1_000_000_000_000,
} as const;

/** Per-identity rate limits (sliding fixed window). */
export const RATE_LIMITS = {
  send_message: { windowSeconds: 60, max: 30 },
  request_agent_run: { windowSeconds: 60, max: 5 },
  create_incident: { windowSeconds: 60, max: 30 },
  /** Every other incident-scoped human write (graph, data scope, evidence, tasks, decisions, lifecycle). */
  incident_write: { windowSeconds: 60, max: 120 },
  /** Service-principal `agent_get_*` reads; each one appends an agent_tool_call row. */
  agent_tool_call: { windowSeconds: 60, max: 120 },
} as const;

/** Agent run lease after a service principal claims it. */
export const AGENT_RUN_LEASE_SECONDS = 15 * 60;

export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
