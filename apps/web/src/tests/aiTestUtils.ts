import { vi } from 'vitest';
import { aiClient, type AIAuthProvider } from '../services/aiClient';
import { MOCK_INCIDENT } from '../fixtures/mockData';

export const INCIDENT_ID = MOCK_INCIDENT.id;
export const RUN_ID = 'run_live_001';
export const TEST_TOKEN = 'test-token-not-a-secret';

export type Route = (init: RequestInit, call: number) => Response | Promise<Response>;

export interface FetchCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

export function envelope(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json({ error: { code, message, request_id: 'req-123', details: {} } }, status, headers);
}

/** Minimal router-style fetch mock keyed by "METHOD /path". */
export function mockFetch(routes: Record<string, Route>) {
  const calls: FetchCall[] = [];
  const counters: Record<string, number> = {};
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const method = (init.method ?? 'GET').toUpperCase();
    const key = `${method} ${path}`;
    const headers = { ...(init.headers as Record<string, string>) };
    calls.push({ method, url, path, headers, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[key];
    if (!route) return envelope(404, 'NOT_FOUND', 'Resource was not found.');
    counters[key] = (counters[key] ?? 0) + 1;
    return route(init, counters[key]);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

export function authProvider(overrides: Partial<AIAuthProvider> = {}): AIAuthProvider {
  return {
    getAccessToken: async () => TEST_TOKEN,
    requestAgentRun: async () => RUN_ID,
    ...overrides,
  };
}

export function configureFastClient(fetchImpl: typeof fetch, auth: AIAuthProvider | null = authProvider()) {
  aiClient.configure({
    baseUrl: 'http://ai.test',
    auth,
    fetchImpl,
    pollInitialMs: 1,
    pollMaxMs: 5,
    pollBackoff: 1.5,
    requestTimeoutMs: 2_000,
    timeoutMs: 5_000,
    exerciseStepMs: 1,
  });
}

export const accepted = (overrides: Record<string, unknown> = {}) => ({
  run_id: RUN_ID,
  status: 'REQUESTED',
  inference_mode: 'LIVE',
  model_identifier: 'nvidia/nemotron-test',
  error_category: null,
  ...overrides,
});

type SubStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

export const subagents = (statuses: [SubStatus, SubStatus, SubStatus, SubStatus], summaries: string[] = []) =>
  (['triage', 'impact', 'containment', 'communications'] as const).map((name, i) => ({
    name,
    status: statuses[i],
    summary: summaries[i] ?? `${name} summary`,
    tool_calls: i + 1,
    provider_calls: 1,
    latency_ms: 100 * (i + 1),
  }));

export const recommendation = (overrides: Record<string, unknown> = {}) => ({
  id: 'rec_live_1',
  run_id: RUN_ID,
  incident_id: INCIDENT_ID,
  organization_id: 'org_1',
  agent_run_id: RUN_ID,
  title: 'Reset krbtgt twice',
  description: 'Invalidate forged Kerberos tickets by resetting krbtgt twice.',
  priority: 'P1',
  rationale: 'Golden ticket indicators on DC-01.',
  inference_mode: 'LIVE',
  model_identifier: 'nvidia/nemotron-test',
  status: 'PENDING',
  evidence_ids: ['ev_1'],
  uncertainties: [],
  created_at: '2026-11-08T08:00:00Z',
  decided_by: null,
  decided_at: null,
  decision_reason: '',
  created_task_id: null,
  ...overrides,
});

export const runRecord = (overrides: Record<string, unknown> = {}) => {
  const mode = (overrides.inference_mode as string) ?? 'LIVE';
  return {
    run_id: RUN_ID,
    organization_id: 'org_1',
    incident_id: INCIDENT_ID,
    requested_by: RUN_ID,
    requested_role: 'COMMANDER',
    status: 'RUNNING',
    inference_mode: mode,
    model_identifier: 'nvidia/nemotron-test',
    analysis_type: 'intake',
    exercise_label: 'EXERCISE',
    focus: null,
    created_at: '2026-11-08T08:00:00Z',
    started_at: '2026-11-08T08:00:01Z',
    finished_at: null,
    error_category: null,
    error_message: null,
    summary: '',
    tool_calls: [],
    provider_calls: [],
    recommendation: null,
    injection_suspected: false,
    redaction_counts: {},
    truthfulness: {
      proposal_only: true,
      live_inference: mode === 'LIVE',
      inference_mode: mode,
      inference_label: mode === 'LIVE' ? 'LIVE_NVIDIA_INFERENCE' : 'SIMULATED',
      approval_required: true,
      notice: 'Proposals require human approval.',
    },
    ...overrides,
  };
};

export const completedRun = (overrides: Record<string, unknown> = {}) =>
  runRecord({
    status: 'COMPLETED',
    finished_at: '2026-11-08T08:00:09Z',
    tool_calls: [
      { id: 'tc1', tool_name: 'get_incident', input_summary: {}, output_summary: {}, status: 'OK', timestamp: '2026-11-08T08:00:02Z', duration_ms: 12 },
    ],
    subagents: subagents(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']),
    sitrep: 'SITREP: ransomware contained to two hosts.',
    recommendation: recommendation(),
    ...overrides,
  });
