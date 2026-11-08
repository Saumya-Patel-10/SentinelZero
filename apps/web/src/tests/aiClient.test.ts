import { describe, it, expect, afterEach, vi } from 'vitest';
import { aiClient, AIServiceError, resolveBaseUrl, type AIRunSnapshot } from '../services/aiClient';
import {
  INCIDENT_ID,
  RUN_ID,
  TEST_TOKEN,
  accepted,
  authProvider,
  completedRun,
  configureFastClient,
  envelope,
  json,
  mockFetch,
  runRecord,
  subagents,
} from './aiTestUtils';

const ANALYZE = `POST /v1/incidents/${INCIDENT_ID}/analyze`;
const GET_RUN = `GET /v1/agent-runs/${RUN_ID}`;
const CANCEL = `POST /v1/agent-runs/${RUN_ID}/cancel`;

async function expectAIError(p: Promise<unknown>): Promise<AIServiceError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AIServiceError);
    return err as AIServiceError;
  }
  throw new Error('expected AIServiceError');
}

describe('aiClient contract', () => {
  afterEach(() => aiClient.reset());

  it('submits the real AnalysisRequest with a bearer token and polls until COMPLETED', async () => {
    const { fetch, calls } = mockFetch({
      [ANALYZE]: () => json(accepted(), 202),
      [GET_RUN]: (_init, n) =>
        n === 1
          ? json(runRecord({ subagents: subagents(['COMPLETED', 'RUNNING', 'PENDING', 'PENDING']) }))
          : json(completedRun()),
    });
    configureFastClient(fetch);
    const updates: AIRunSnapshot[] = [];

    const result = await aiClient.runAnalysis({ incidentId: INCIDENT_ID, analysisType: 'impact', onUpdate: (s) => updates.push(s) });

    const post = calls[0];
    expect(post.method).toBe('POST');
    expect(post.path).toBe(`/v1/incidents/${INCIDENT_ID}/analyze`);
    expect(post.body).toEqual({ incident_id: INCIDENT_ID, run_id: RUN_ID, analysis_type: 'impact' });
    expect(calls.every((c) => c.headers.Authorization === `Bearer ${TEST_TOKEN}`)).toBe(true);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);

    expect(result.source).toBe('LIVE_SERVICE');
    expect(result.run.status).toBe('COMPLETED');
    expect(result.run.subagents?.map((s) => s.name)).toEqual(['triage', 'impact', 'containment', 'communications']);
    expect(result.run.recommendation?.status).toBe('PENDING');
    expect(updates.map((u) => u.run.status)).toEqual(['REQUESTED', 'RUNNING', 'COMPLETED']);
  });

  it('accepts runs from an older service without subagents or sitrep', async () => {
    const { fetch } = mockFetch({
      [ANALYZE]: () => json(accepted(), 202),
      [GET_RUN]: () => json(completedRun({ subagents: undefined, sitrep: undefined })),
    });
    configureFastClient(fetch);
    const result = await aiClient.runAnalysis({ incidentId: INCIDENT_ID, analysisType: 'intake' });
    expect(result.run.subagents).toBeUndefined();
    expect(result.run.sitrep).toBeUndefined();
  });

  it.each([
    ['unknown subagent status', completedRun({ subagents: subagents(['COMPLETED', 'DONE' as never, 'PENDING', 'PENDING']) })],
    ['subagents out of order', completedRun({ subagents: subagents(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']).reverse() })],
    ['negative tool count', completedRun({ subagents: subagents(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']).map((s) => ({ ...s, tool_calls: -1 })) })],
    ['unknown run status', runRecord({ status: 'APPROVED' })],
    ['non-object body', 'not-json-object'],
    ['truthfulness contradicts inference_mode', runRecord({ inference_mode: 'SIMULATED', truthfulness: { proposal_only: true, live_inference: true, inference_mode: 'SIMULATED', approval_required: true } })],
    ['different run id', completedRun({ run_id: 'run_other' })],
  ])('rejects malformed run data (%s) and cancels the discarded run', async (_label, body) => {
    const { fetch, calls } = mockFetch({
      [ANALYZE]: () => json(accepted(), 202),
      [GET_RUN]: () => json(body),
      [CANCEL]: () => json({ run_id: RUN_ID, status: 'CANCELLED' }, 202),
    });
    configureFastClient(fetch);
    const err = await expectAIError(aiClient.runAnalysis({ incidentId: INCIDENT_ID, analysisType: 'intake' }));
    expect(err.kind).toBe('MALFORMED_RESPONSE');
    await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith('/cancel'))).toBe(true));
  });

  it('rejects a malformed 202 acceptance', async () => {
    const { fetch } = mockFetch({ [ANALYZE]: () => json({ run_id: RUN_ID, status: 'RUNNING', inference_mode: 'TOTALLY_LIVE', model_identifier: 'x' }, 202) });
    configureFastClient(fetch);
    const err = await expectAIError(aiClient.runAnalysis({ incidentId: INCIDENT_ID, analysisType: 'intake' }));
    expect(err.kind).toBe('MALFORMED_RESPONSE');
  });

  it.each([
    [401, 'AUTH_REQUIRED', 'A bearer token is required.', {}],
    [403, 'ACCESS_DENIED', 'You must be the requester of a REQUESTED run to start analysis.', {}],
    [429, 'RATE_LIMITED', 'Too many analysis requests. Retry later.', { 'Retry-After': '17' }],
    [503, 'SERVICE_UNAVAILABLE', 'The AI provider is not configured. Manual incident workflows remain available.', {}],
  ] as const)('maps a %i error envelope to a safe typed error', async (status, code, message, headers) => {
    const { fetch } = mockFetch({ [ANALYZE]: () => envelope(status, code, message, headers) });
    configureFastClient(fetch);
    const err = await expectAIError(aiClient.runAnalysis({ incidentId: INCIDENT_ID, analysisType: 'intake' }));
    expect(err.kind).toBe(code);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.message).toBe(message);
    expect(err.requestId).toBe('req-123');
    expect(err.retryAfterSeconds).toBe(status === 429 ? 17 : null);
  });

  it('falls back to a default message when the error body is not a valid envelope', async () => {
    const { fetch } = mockFetch({ [ANALYZE]: () => new Response('<html>Bad Gateway</html>', { status: 502 }) });
    configureFastClient(fetch);
    const err = await expectAIError(aiClient.runAnalysis({ incidentId: INCIDENT_ID, analysisType: 'intake' }));
    expect(err.kind).toBe('SERVICE_UNAVAILABLE');
    expect(err.message).not.toContain('<html>');
    expect(err.code).toBeNull();
  });

  it('aborting during polling calls the cancel endpoint with the bearer token', async () => {
    const controller = new AbortController();
    const { fetch, calls } = mockFetch({
      [ANALYZE]: () => json(accepted(), 202),
      [GET_RUN]: () => json(runRecord({ subagents: subagents(['RUNNING', 'PENDING', 'PENDING', 'PENDING']) })),
      [CANCEL]: () => json({ run_id: RUN_ID, status: 'CANCELLED' }, 202),
    });
    configureFastClient(fetch);
    const p = aiClient.runAnalysis({
      incidentId: INCIDENT_ID,
      analysisType: 'intake',
      signal: controller.signal,
      onUpdate: (s) => {
        if (s.run.status === 'RUNNING') controller.abort();
      },
    });
    const err = await expectAIError(p);
    expect(err.kind).toBe('CANCELLED');
    await vi.waitFor(() => {
      const cancel = calls.find((c) => c.path === `/v1/agent-runs/${RUN_ID}/cancel`);
      expect(cancel?.method).toBe('POST');
      expect(cancel?.headers.Authorization).toBe(`Bearer ${TEST_TOKEN}`);
    });
  });

  it('enforces a hard timeout and cancels the run server-side', async () => {
    const { fetch, calls } = mockFetch({
      [ANALYZE]: () => json(accepted(), 202),
      [GET_RUN]: () => json(runRecord()),
      [CANCEL]: () => json({ run_id: RUN_ID, status: 'CANCELLED' }, 202),
    });
    configureFastClient(fetch);
    aiClient.configure({ timeoutMs: 40 });
    const err = await expectAIError(aiClient.runAnalysis({ incidentId: INCIDENT_ID, analysisType: 'intake' }));
    expect(err.kind).toBe('TIMEOUT');
    await vi.waitFor(() => expect(calls.some((c) => c.path.endsWith('/cancel'))).toBe(true));
  });

  it('falls back to a labeled SIMULATED exercise when the service is unreachable', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    configureFastClient(fetch);
    const result = await aiClient.runAnalysis({ incidentId: INCIDENT_ID, analysisType: 'intake' });
    expect(result.source).toBe('EXERCISE_FALLBACK');
    expect(result.run.inference_mode).toBe('SIMULATED');
    expect(result.run.truthfulness?.live_inference).toBe(false);
    expect(result.fallbackReason).toMatch(/unreachable/i);
    expect(result.run.subagents?.every((s) => s.status === 'COMPLETED')).toBe(true);
    expect(result.run.sitrep).toMatch(/EXERCISE SCENARIO/);
    expect(result.run.recommendation?.status).toBe('PENDING');
  });

  it('never touches the network when no auth provider is configured', async () => {
    const { fetch, calls } = mockFetch({});
    configureFastClient(fetch, null);
    const result = await aiClient.runAnalysis({ incidentId: INCIDENT_ID, analysisType: 'intake' });
    expect(result.source).toBe('EXERCISE_FALLBACK');
    expect(calls).toHaveLength(0);
  });

  it('falls back when no session token is available instead of sending an unauthenticated request', async () => {
    const { fetch, calls } = mockFetch({});
    configureFastClient(fetch, authProvider({ getAccessToken: async () => null }));
    const result = await aiClient.runAnalysis({ incidentId: INCIDENT_ID, analysisType: 'intake' });
    expect(result.source).toBe('EXERCISE_FALLBACK');
    expect(calls).toHaveLength(0);
  });

  it('only accepts http(s) base URLs without embedded credentials', () => {
    expect(resolveBaseUrl('http://localhost:8000/')).toBe('http://localhost:8000');
    expect(resolveBaseUrl('https://ai.example.org/api/')).toBe('https://ai.example.org/api');
    expect(resolveBaseUrl('javascript:alert(1)')).toBeNull();
    expect(resolveBaseUrl('https://user:pass@ai.example.org')).toBeNull();
    expect(resolveBaseUrl('disabled')).toBeNull();
    expect(resolveBaseUrl('')).toBeNull();
    expect(resolveBaseUrl(undefined)).toBe('http://localhost:8000');
  });
});
