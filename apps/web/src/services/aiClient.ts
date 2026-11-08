/**
 * SentinelZero AI Service Client (FastAPI / NVIDIA Nemotron sub-agent pipeline).
 *
 * Wire contract (services/ai/app/routes/analyze.py, schemas.py):
 *   POST /v1/incidents/{incident_id}/analyze  body {incident_id, run_id, analysis_type} -> 202 AnalysisAccepted
 *   GET  /v1/agent-runs/{run_id}              -> run record (+ optional subagents[], sitrep)
 *   POST /v1/agent-runs/{run_id}/cancel       -> 202 {run_id, status: "CANCELLED"}
 * Every call carries `Authorization: Bearer <token>` obtained from an injected provider.
 *
 * Truthfulness: only a validated service response with inference_mode === 'LIVE' is shown as live.
 * When the service is unconfigured or unreachable the client runs a local EXERCISE SCENARIO that is
 * always SIMULATED. Recommendations are PENDING proposals; nothing here can approve or execute them.
 */

import { z } from 'zod';
import {
  AGENT_RUN_STATUSES,
  ANALYSIS_TYPES,
  INFERENCE_MODES,
  RECOMMENDATION_STATUSES,
  TASK_PRIORITIES,
  type AnalysisType,
} from '@shared/enums';
import { MOCK_RECOMMENDATIONS } from '../fixtures/mockData';

// ---------------------------------------------------------------------------
// Runtime schemas (unknown keys are stripped; wrong types are rejected)
// ---------------------------------------------------------------------------

export const SUBAGENT_NAMES = ['triage', 'impact', 'containment', 'communications'] as const;
export const SUBAGENT_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED'] as const;
export const TERMINAL_RUN_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const;

const Id = z.string().min(1).max(64);
const Count = z.number().int().nonnegative().max(1_000_000);

const SubagentSchema = z.object({
  name: z.enum(SUBAGENT_NAMES),
  status: z.enum(SUBAGENT_STATUSES),
  summary: z.string().max(5000),
  tool_calls: Count,
  provider_calls: Count,
  latency_ms: z.number().nonnegative().finite().max(86_400_000),
});

const SubagentListSchema = z
  .array(SubagentSchema)
  .max(SUBAGENT_NAMES.length)
  .refine(
    (list) => list.every((s, i) => i === 0 || SUBAGENT_NAMES.indexOf(s.name) > SUBAGENT_NAMES.indexOf(list[i - 1].name)),
    { message: 'subagents must be unique and in pipeline order' }
  );

const ToolCallSchema = z.object({
  id: z.string().min(1).max(160),
  tool_name: z.string().min(1).max(60),
  status: z.enum(['OK', 'ERROR']),
  timestamp: z.string().max(64),
  duration_ms: Count,
});

const ProviderCallSchema = z.object({
  step: z.number().int().positive(),
  status: z.enum(['OK', 'ERROR']),
  latency_ms: Count,
});

const RecommendationSchema = z.object({
  id: z.string().min(1).max(160),
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(5000),
  priority: z.enum(TASK_PRIORITIES),
  rationale: z.string().min(1).max(1500),
  status: z.enum(RECOMMENDATION_STATUSES),
  evidence_ids: z.array(z.string().max(80)).max(32).default([]),
  uncertainties: z.array(z.string().max(1000)).max(32).default([]),
});

const TruthfulnessSchema = z.object({
  proposal_only: z.literal(true),
  live_inference: z.boolean(),
  inference_mode: z.enum(INFERENCE_MODES),
  approval_required: z.literal(true),
  notice: z.string().max(500).optional(),
});

const nullableString = (max: number) => z.string().max(max).nullable().optional();

export const AgentRunSchema = z
  .object({
    run_id: Id,
    incident_id: z.string().min(1).max(160),
    status: z.enum(AGENT_RUN_STATUSES),
    inference_mode: z.enum(INFERENCE_MODES),
    model_identifier: z.string().max(200),
    analysis_type: z.enum(ANALYSIS_TYPES).optional(),
    created_at: z.string().max(64).optional(),
    started_at: nullableString(64),
    finished_at: nullableString(64),
    error_category: nullableString(60),
    error_message: nullableString(300),
    summary: z.string().max(5000).default(''),
    tool_calls: z.array(ToolCallSchema).max(64).default([]),
    provider_calls: z.array(ProviderCallSchema).max(32).default([]),
    recommendation: RecommendationSchema.nullable().optional(),
    injection_suspected: z.boolean().optional(),
    truthfulness: TruthfulnessSchema.optional(),
    subagents: SubagentListSchema.optional(),
    sitrep: z.string().max(10_000).optional(),
  })
  .superRefine((run, ctx) => {
    const t = run.truthfulness;
    if (t && (t.inference_mode !== run.inference_mode || t.live_inference !== (run.inference_mode === 'LIVE'))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'truthfulness block contradicts inference_mode' });
    }
  });

const AnalysisAcceptedSchema = z.object({
  run_id: Id,
  status: z.enum(AGENT_RUN_STATUSES),
  inference_mode: z.enum(INFERENCE_MODES),
  model_identifier: z.string().max(200),
  error_category: nullableString(60),
});

const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().max(2000),
    request_id: z.string().max(128).nullable().optional(),
    details: z.record(z.unknown()).optional(),
  }),
});

const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  inference_mode: z.enum(INFERENCE_MODES),
  provider: z
    .object({
      model_identifier: z.string().max(200),
      live_inference_available: z.boolean(),
    })
    .optional(),
});

export type SubagentName = (typeof SUBAGENT_NAMES)[number];
export type SubagentStatus = (typeof SUBAGENT_STATUSES)[number];
export type Subagent = z.infer<typeof SubagentSchema>;
export type AgentRunRecord = z.infer<typeof AgentRunSchema>;
export type AIRecommendation = z.infer<typeof RecommendationSchema>;
export type AIServiceHealth = z.infer<typeof HealthSchema>;
export type { AnalysisType };

export function isTerminalStatus(status: AgentRunRecord['status']): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AIErrorKind =
  | 'AUTH_REQUIRED'
  | 'ACCESS_DENIED'
  | 'RATE_LIMITED'
  | 'SERVICE_UNAVAILABLE'
  | 'VALIDATION_FAILED'
  | 'INVALID_STATE'
  | 'NOT_FOUND'
  | 'MALFORMED_RESPONSE'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UNREACHABLE'
  | 'HTTP_ERROR';

const SAFE_MESSAGE_MAX = 300;

/** Strips control characters and bounds length; rendered as React text only. */
function safeText(value: string, max = SAFE_MESSAGE_MAX): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export class AIServiceError extends Error {
  readonly kind: AIErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: AIErrorKind,
    message: string,
    opts: { status?: number | null; code?: string | null; requestId?: string | null; retryAfterSeconds?: number | null } = {}
  ) {
    super(safeText(message));
    this.name = 'AIServiceError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.requestId = opts.requestId ?? null;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}

const KIND_BY_STATUS: Record<number, AIErrorKind> = {
  401: 'AUTH_REQUIRED',
  403: 'ACCESS_DENIED',
  404: 'NOT_FOUND',
  409: 'INVALID_STATE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

const DEFAULT_MESSAGE_BY_KIND: Record<AIErrorKind, string> = {
  AUTH_REQUIRED: 'Authentication is required to use the AI service.',
  ACCESS_DENIED: 'Your role is not permitted to perform this AI action.',
  RATE_LIMITED: 'Too many analysis requests. Retry later.',
  SERVICE_UNAVAILABLE: 'The AI service is unavailable. Manual incident workflows remain available.',
  VALIDATION_FAILED: 'The analysis request was rejected as invalid.',
  INVALID_STATE: 'The run is not in a state that allows this action.',
  NOT_FOUND: 'The agent run was not found.',
  MALFORMED_RESPONSE: 'The AI service returned a response that failed validation and was discarded.',
  TIMEOUT: 'The analysis exceeded its time limit and was cancelled.',
  CANCELLED: 'The analysis was cancelled.',
  UNREACHABLE: 'The AI service could not be reached.',
  HTTP_ERROR: 'The AI service returned an unexpected error.',
};

async function errorFromResponse(res: Response): Promise<AIServiceError> {
  const kind = KIND_BY_STATUS[res.status] ?? (res.status >= 500 ? 'SERVICE_UNAVAILABLE' : 'HTTP_ERROR');
  const retryHeader = res.headers.get('Retry-After');
  const retryParsed = retryHeader !== null ? Number.parseInt(retryHeader, 10) : NaN;
  const retryAfterSeconds = Number.isFinite(retryParsed) && retryParsed >= 0 ? Math.min(retryParsed, 3600) : null;

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error bodies are ignored; only the status code is trusted.
  }
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  const message = parsed.success && parsed.data.error.message ? parsed.data.error.message : DEFAULT_MESSAGE_BY_KIND[kind];
  return new AIServiceError(kind, message, {
    status: res.status,
    code: parsed.success ? safeText(parsed.data.error.code, 80) : null,
    requestId: parsed.success && parsed.data.error.request_id ? safeText(parsed.data.error.request_id, 128) : null,
    retryAfterSeconds,
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Supplies credentials and the SpacetimeDB-minted run id. The browser must call the
 * `request_agent_run` reducer first; the AI service never mints run ids.
 */
export interface AIAuthProvider {
  /** Short-lived user bearer token (OIDC/SpacetimeDB). Return null when no session exists. */
  getAccessToken: () => Promise<string | null>;
  /** Calls SpacetimeDB `request_agent_run` and returns the new run id, or null if unavailable. */
  requestAgentRun: (incidentId: string, analysisType: AnalysisType) => Promise<string | null>;
}

export interface AIClientConfig {
  /** Base URL of the AI service, or null when unconfigured. */
  baseUrl: string | null;
  auth: AIAuthProvider | null;
  fetchImpl?: typeof fetch;
  /** Hard ceiling for a whole analysis (submit + polling). */
  timeoutMs: number;
  /** Per-request network timeout. */
  requestTimeoutMs: number;
  pollInitialMs: number;
  pollMaxMs: number;
  pollBackoff: number;
  /** Delay between simulated pipeline stages in exercise mode. */
  exerciseStepMs: number;
}

export function resolveBaseUrl(raw: string | undefined): string | null {
  const value = (raw ?? 'http://localhost:8000').trim();
  if (!value || value.toLowerCase() === 'disabled' || value.toLowerCase() === 'off') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

const DEFAULT_CONFIG: AIClientConfig = {
  baseUrl: resolveBaseUrl(import.meta.env.VITE_AI_SERVICE_URL),
  auth: null,
  timeoutMs: 120_000,
  requestTimeoutMs: 15_000,
  pollInitialMs: 500,
  pollMaxMs: 4_000,
  pollBackoff: 1.5,
  exerciseStepMs: 350,
};

// ---------------------------------------------------------------------------
// Run snapshots delivered to the UI
// ---------------------------------------------------------------------------

export type AIRunSource = 'LIVE_SERVICE' | 'EXERCISE_FALLBACK';

export interface AIRunSnapshot {
  source: AIRunSource;
  run: AgentRunRecord;
  /** Present only in exercise fallback; explains why live inference was not used. */
  fallbackReason?: string;
}

export interface RunAnalysisOptions {
  incidentId: string;
  analysisType: AnalysisType;
  signal?: AbortSignal;
  onUpdate?: (snapshot: AIRunSnapshot) => void;
}

function abortError(): AIServiceError {
  return new AIServiceError('CANCELLED', DEFAULT_MESSAGE_BY_KIND.CANCELLED);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class UnreachableError extends Error {}

export class AIServiceClient {
  private config: AIClientConfig;

  constructor(config: Partial<AIClientConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  configure(patch: Partial<AIClientConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  reset(): void {
    this.config = { ...DEFAULT_CONFIG };
  }

  /** Live analysis is possible only with a base URL and an auth provider. */
  get isLiveConfigured(): boolean {
    return this.config.baseUrl !== null && this.config.auth !== null;
  }

  private get fetchFn(): typeof fetch {
    return this.config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; signal?: AbortSignal; auth?: boolean } = {}
  ): Promise<Response> {
    const { baseUrl, auth, requestTimeoutMs } = this.config;
    if (!baseUrl) throw new UnreachableError('AI service URL is not configured');

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false) {
      const token = auth ? await auth.getAccessToken() : null;
      if (!token) throw new AIServiceError('AUTH_REQUIRED', DEFAULT_MESSAGE_BY_KIND.AUTH_REQUIRED);
      headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      return await this.fetchFn(`${baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      });
    } catch (err) {
      if (opts.signal?.aborted) throw abortError();
      if (controller.signal.aborted) throw new AIServiceError('TIMEOUT', 'The AI service did not respond in time.');
      throw new UnreachableError(err instanceof Error ? err.message : 'network error');
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  private async readJson<T>(res: Response, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new AIServiceError('MALFORMED_RESPONSE', DEFAULT_MESSAGE_BY_KIND.MALFORMED_RESPONSE, { status: res.status });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new AIServiceError('MALFORMED_RESPONSE', DEFAULT_MESSAGE_BY_KIND.MALFORMED_RESPONSE, { status: res.status });
    }
    return parsed.data;
  }

  async getHealth(signal?: AbortSignal): Promise<AIServiceHealth | null> {
    try {
      const res = await this.request('GET', '/health', { signal, auth: false });
      if (!res.ok) return null;
      return await this.readJson(res, HealthSchema);
    } catch {
      return null;
    }
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<AgentRunRecord> {
    const res = await this.request('GET', `/v1/agent-runs/${encodeURIComponent(runId)}`, { signal });
    if (!res.ok) throw await errorFromResponse(res);
    const run = await this.readJson(res, AgentRunSchema);
    if (run.run_id !== runId) {
      throw new AIServiceError('MALFORMED_RESPONSE', 'The AI service returned a different run than requested.');
    }
    return run;
  }

  /** Best-effort server-side cancellation. Never throws. */
  async cancelRun(runId: string): Promise<boolean> {
    try {
      const res = await this.request('POST', `/v1/agent-runs/${encodeURIComponent(runId)}/cancel`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Starts analysis and resolves with the terminal run. Falls back to a clearly labeled
   * exercise scenario only when the service is unconfigured or unreachable before submission.
   */
  async runAnalysis(opts: RunAnalysisOptions): Promise<AIRunSnapshot> {
    if (opts.signal?.aborted) throw abortError();
    const { baseUrl, auth } = this.config;
    if (!baseUrl) return this.runExercise(opts, 'AI service URL is not configured.');
    if (!auth) return this.runExercise(opts, 'No authenticated AI session is configured for this client.');

    const token = await auth.getAccessToken();
    if (!token) return this.runExercise(opts, 'No authenticated session token is available.');

    const runId = await auth.requestAgentRun(opts.incidentId, opts.analysisType);
    if (!runId) return this.runExercise(opts, 'The incident backend could not create an agent run.');
    if (!Id.safeParse(runId).success) {
      throw new AIServiceError('VALIDATION_FAILED', 'The incident backend returned an invalid run id.');
    }

    let res: Response;
    try {
      res = await this.request('POST', `/v1/incidents/${encodeURIComponent(opts.incidentId)}/analyze`, {
        body: { incident_id: opts.incidentId, run_id: runId, analysis_type: opts.analysisType },
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof UnreachableError) return this.runExercise(opts, 'The AI service is unreachable.');
      throw err;
    }
    if (!res.ok) throw await errorFromResponse(res);
    const accepted = await this.readJson(res, AnalysisAcceptedSchema);
    if (accepted.run_id !== runId) {
      throw new AIServiceError('MALFORMED_RESPONSE', 'The AI service accepted a different run than requested.');
    }

    opts.onUpdate?.({
      source: 'LIVE_SERVICE',
      run: {
        run_id: accepted.run_id,
        incident_id: opts.incidentId,
        status: accepted.status,
        inference_mode: accepted.inference_mode,
        model_identifier: accepted.model_identifier,
        error_category: accepted.error_category,
        summary: '',
        tool_calls: [],
        provider_calls: [],
      },
    });

    return this.pollUntilTerminal(runId, opts);
  }

  private async pollUntilTerminal(runId: string, opts: RunAnalysisOptions): Promise<AIRunSnapshot> {
    const { timeoutMs, pollInitialMs, pollMaxMs, pollBackoff } = this.config;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const combined = new AbortController();
    const abortCombined = () => combined.abort();
    opts.signal?.addEventListener('abort', abortCombined, { once: true });
    deadline.signal.addEventListener('abort', abortCombined, { once: true });

    let interval = pollInitialMs;
    try {
      for (;;) {
        await sleep(interval, combined.signal);
        let run: AgentRunRecord;
        try {
          run = await this.getRun(runId, combined.signal);
        } catch (err) {
          if (err instanceof UnreachableError) {
            throw new AIServiceError('UNREACHABLE', 'Lost contact with the AI service while the run was in progress.');
          }
          throw err;
        }
        if (run.incident_id !== opts.incidentId) {
          throw new AIServiceError('MALFORMED_RESPONSE', 'The AI service returned a run for a different incident.');
        }
        const snapshot: AIRunSnapshot = { source: 'LIVE_SERVICE', run };
        opts.onUpdate?.(snapshot);
        if (isTerminalStatus(run.status)) return snapshot;
        interval = Math.min(Math.round(interval * pollBackoff), pollMaxMs);
      }
    } catch (err) {
      const timedOut = deadline.signal.aborted && !opts.signal?.aborted;
      if (combined.signal.aborted) {
        void this.cancelRun(runId);
        if (timedOut) throw new AIServiceError('TIMEOUT', DEFAULT_MESSAGE_BY_KIND.TIMEOUT);
        throw abortError();
      }
      if (err instanceof AIServiceError && err.kind === 'MALFORMED_RESPONSE') void this.cancelRun(runId);
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortCombined);
    }
  }

  // -------------------------------------------------------------------------
  // Exercise scenario (local, SIMULATED, never presented as live)
  // -------------------------------------------------------------------------

  private async runExercise(opts: RunAnalysisOptions, reason: string): Promise<AIRunSnapshot> {
    const runId = `exercise-${Date.now().toString(36)}`;
    const started = new Date().toISOString();
    const stages = buildExerciseStages();
    const subagents: Subagent[] = SUBAGENT_NAMES.map((name) => ({
      name,
      status: 'PENDING',
      summary: '',
      tool_calls: 0,
      provider_calls: 0,
      latency_ms: 0,
    }));

    const base: AgentRunRecord = {
      run_id: runId,
      incident_id: opts.incidentId,
      status: 'RUNNING',
      inference_mode: 'SIMULATED',
      model_identifier: 'exercise-scenario (no model inference)',
      analysis_type: opts.analysisType,
      created_at: started,
      started_at: started,
      summary: '',
      tool_calls: [],
      provider_calls: [],
      truthfulness: {
        proposal_only: true,
        live_inference: false,
        inference_mode: 'SIMULATED',
        approval_required: true,
        notice: 'EXERCISE SCENARIO: simulated output, not live inference. Proposals require human approval.',
      },
    };

    const emit = (run: AgentRunRecord): AIRunSnapshot => {
      const snapshot: AIRunSnapshot = { source: 'EXERCISE_FALLBACK', run, fallbackReason: reason };
      opts.onUpdate?.(snapshot);
      return snapshot;
    };

    emit({ ...base, subagents: subagents.map((s) => ({ ...s })) });

    for (let i = 0; i < stages.length; i++) {
      subagents[i] = { ...subagents[i], status: 'RUNNING' };
      emit({ ...base, subagents: subagents.map((s) => ({ ...s })) });
      const stageStart = Date.now();
      await sleep(this.config.exerciseStepMs, opts.signal);
      subagents[i] = { ...subagents[i], ...stages[i], status: 'COMPLETED', latency_ms: Date.now() - stageStart };
    }

    const rec = MOCK_RECOMMENDATIONS[0];
    return emit({
      ...base,
      status: 'COMPLETED',
      finished_at: new Date().toISOString(),
      summary: 'EXERCISE SCENARIO: synthetic walkthrough of the four-stage sub-agent pipeline.',
      tool_calls: [
        { id: `${runId}-tc1`, tool_name: 'get_incident', status: 'OK', timestamp: started, duration_ms: 12 },
        { id: `${runId}-tc2`, tool_name: 'get_assets', status: 'OK', timestamp: started, duration_ms: 18 },
        { id: `${runId}-tc3`, tool_name: 'get_dependencies', status: 'OK', timestamp: started, duration_ms: 15 },
        { id: `${runId}-tc4`, tool_name: 'propose_task', status: 'OK', timestamp: started, duration_ms: 9 },
      ],
      subagents: subagents.map((s) => ({ ...s })),
      sitrep:
        'EXERCISE SCENARIO - DRAFT SITREP (not live inference, not sent)\n' +
        'Situation: simulated ransomware impact on clinical systems.\n' +
        'Proposed next step: credential containment, pending Incident Commander approval.',
      recommendation: {
        id: `${runId}-rec1`,
        title: rec.title,
        description: rec.description,
        priority: 'P1',
        rationale: rec.rationale,
        status: 'PENDING',
        evidence_ids: [],
        uncertainties: ['Exercise data only; no live evidence was evaluated.'],
      },
    });
  }
}

function buildExerciseStages(): Array<Pick<Subagent, 'summary' | 'tool_calls' | 'provider_calls'>> {
  return [
    { summary: 'EXERCISE: classified as ransomware with suspected credential theft.', tool_calls: 2, provider_calls: 0 },
    { summary: 'EXERCISE: EHR and imaging services marked degraded; data exposure unverified.', tool_calls: 2, provider_calls: 0 },
    { summary: 'EXERCISE: proposed krbtgt double reset as a PENDING recommendation.', tool_calls: 1, provider_calls: 0 },
    { summary: 'EXERCISE: drafted internal sitrep for Incident Commander review.', tool_calls: 0, provider_calls: 0 },
  ];
}

export const aiClient = new AIServiceClient();

/** Wires the real session/run provider (e.g. SpacetimeDB auth) into the shared client. */
export function configureAIAuth(provider: AIAuthProvider | null): void {
  aiClient.configure({ auth: provider });
}
