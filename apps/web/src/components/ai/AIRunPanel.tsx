import React, { useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import {
  aiClient,
  AIServiceError,
  isTerminalStatus,
  type AIRecommendation,
  type AIRunSnapshot,
  type AnalysisType,
  type AgentRunRecord,
} from '../../services/aiClient';
import { useIncidents } from '../../hooks/useIncidents';
import { useTasks } from '../../hooks/useTasks';
import { useAuth } from '../../hooks/useAuth';
import { useUIStore } from '../../stores/uiStore';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ExerciseBadge } from '../ui/Badge';
import { SubagentPipeline } from './SubagentPipeline';
import { TaskPriority } from '../../services/contracts';
import { AlertTriangle, Clock, Cpu, FileText, Lock, Play, ShieldAlert, Sparkles, Square, Terminal } from 'lucide-react';

type Phase = 'idle' | 'running' | 'done' | 'error';

const ANALYSIS_OPTIONS: Array<{ value: AnalysisType; label: string }> = [
  { value: 'intake', label: 'Intake (triage + initial impact)' },
  { value: 'impact', label: 'Impact (services + data exposure)' },
  { value: 'response', label: 'Response (containment + comms)' },
];

const PRIORITY_TO_TASK: Record<AIRecommendation['priority'], TaskPriority> = {
  P1: 'CRITICAL',
  P2: 'HIGH',
  P3: 'MEDIUM',
  P4: 'LOW',
};

const ERROR_TITLES: Record<AIServiceError['kind'], string> = {
  AUTH_REQUIRED: 'Authentication required (401)',
  ACCESS_DENIED: 'Access denied (403)',
  RATE_LIMITED: 'Rate limited (429)',
  SERVICE_UNAVAILABLE: 'AI service unavailable',
  VALIDATION_FAILED: 'Request rejected',
  INVALID_STATE: 'Invalid run state',
  NOT_FOUND: 'Run not found',
  MALFORMED_RESPONSE: 'Malformed AI response rejected',
  TIMEOUT: 'Analysis timed out',
  CANCELLED: 'Analysis cancelled',
  UNREACHABLE: 'AI service unreachable',
  HTTP_ERROR: 'AI service error',
};

const InferenceBadge: React.FC<{ snapshot: AIRunSnapshot }> = ({ snapshot }) => {
  const mode = snapshot.run.inference_mode;
  const isLive = mode === 'LIVE' && snapshot.source === 'LIVE_SERVICE';
  const label = isLive ? 'LIVE INFERENCE' : mode === 'FIXTURE' ? 'FIXTURE · NOT LIVE INFERENCE' : 'SIMULATED · NOT LIVE INFERENCE';
  return (
    <span
      data-testid="ai-inference-mode"
      data-mode={isLive ? 'LIVE' : mode === 'LIVE' ? 'SIMULATED' : mode}
      className={clsx(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono font-semibold',
        isLive ? 'bg-emerald-950/60 text-emerald-300 border-emerald-600/60' : 'bg-amber-950/60 text-amber-300 border-amber-600/60'
      )}
    >
      {label}
    </span>
  );
};

function describeRun(run: AgentRunRecord): string {
  const stages = (run.subagents ?? []).map((s) => `${s.name} ${s.status.toLowerCase()}`).join(', ');
  return `Analysis run ${run.status.toLowerCase()}${stages ? `. Sub-agents: ${stages}` : ''}.`;
}

export const AIRunPanel: React.FC = () => {
  const { incident } = useIncidents();
  const { createTask } = useTasks();
  const { role, canRequestAgentRun, canViewAgentActivity, can } = useAuth();
  const isAIPanelOpen = useUIStore((s) => s.isAIPanelOpen);
  const setAIPanelOpen = useUIStore((s) => s.setAIPanelOpen);
  const prefersReducedMotion = useUIStore((s) => s.prefersReducedMotion);

  const [analysisType, setAnalysisType] = useState<AnalysisType>('intake');
  const [phase, setPhase] = useState<Phase>('idle');
  const [snapshot, setSnapshot] = useState<AIRunSnapshot | null>(null);
  const [error, setError] = useState<AIServiceError | null>(null);
  const [queuedRecIds, setQueuedRecIds] = useState<Set<string>>(new Set());
  const [queueError, setQueueError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const closePanel = useCallback(() => setAIPanelOpen(false), [setAIPanelOpen]);

  const handleRunAnalysis = async () => {
    if (!incident || !canRequestAgentRun || phase === 'running') return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('running');
    setError(null);
    setSnapshot(null);
    setQueueError(null);
    try {
      const final = await aiClient.runAnalysis({
        incidentId: incident.id,
        analysisType,
        signal: controller.signal,
        onUpdate: (s) => {
          if (mountedRef.current && !controller.signal.aborted) setSnapshot(s);
        },
      });
      if (!mountedRef.current) return;
      setSnapshot(final);
      setPhase('done');
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof AIServiceError ? err : new AIServiceError('HTTP_ERROR', 'Unexpected client error.'));
      setPhase('error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const handleCancel = () => {
    abortRef.current?.abort();
  };

  const handleQueueForApproval = async (rec: AIRecommendation) => {
    if (!can('CREATE_TASK') || rec.status !== 'PENDING' || !incident) return;
    setQueueError(null);
    try {
      await createTask({
        title: `AI PROPOSAL: ${rec.title}`.slice(0, 120),
        description: `${rec.description}\n\n[Rationale]: ${rec.rationale}`.slice(0, 1000),
        priority: PRIORITY_TO_TASK[rec.priority],
        assigned_identity: incident.commander_identity,
        requires_approval: true,
        is_ai_proposed: true,
      });
      setQueuedRecIds((prev) => new Set([...prev, rec.id]));
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : 'Could not queue the proposal.');
    }
  };

  const run = snapshot?.run ?? null;
  const failedStages = (run?.subagents ?? []).filter((s) => s.status === 'FAILED');
  const showRecommendation = !!run && run.status === 'COMPLETED' && failedStages.length === 0 && !!run.recommendation;
  const isRunning = phase === 'running';

  return (
    <Modal
      isOpen={isAIPanelOpen}
      onClose={closePanel}
      title="NVIDIA Nemotron Incident Copilot"
      subtitle="Four read-only Nemotron sub-agents (triage, impact, containment, communications). Output is a proposal only; every recommendation stays PENDING until the Incident Commander decides."
      maxWidth="2xl"
      testId="ai-run-panel-dialog"
    >
      <div data-testid="ai-run-panel" className="space-y-5">
        {/* Screen-reader status channel */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="ai-run-live-status">
          {isRunning && !run ? 'Analysis requested.' : run ? describeRun(run) : ''}
          {error ? ` ${ERROR_TITLES[error.kind]}.` : ''}
        </div>

        {!canViewAgentActivity ? (
          <div
            data-testid="ai-run-forbidden"
            className="flex items-start gap-2 p-3.5 rounded-lg border border-slate-700 bg-sz-bg-base text-xs text-slate-300"
          >
            <Lock className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" aria-hidden="true" />
            <p>
              Your role (<strong className="font-mono">{role}</strong>) cannot request or view AI analysis. Only Owner, Incident
              Commander, and Analyst roles may use the copilot.
            </p>
          </div>
        ) : (
          <>
            {/* Run Controls */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-lg bg-sz-bg-base border border-sz-bg-border">
              <div className="flex items-center gap-2">
                <Cpu className="w-5 h-5 text-cyan-400" aria-hidden="true" />
                <div>
                  <label htmlFor="ai-analysis-type" className="block text-xs font-mono font-semibold text-slate-200">
                    Analysis Type
                  </label>
                  <div className="text-[11px] text-slate-400">Read-only tools; proposals only</div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <select
                  id="ai-analysis-type"
                  data-testid="ai-analysis-type"
                  value={analysisType}
                  disabled={isRunning}
                  onChange={(e) => setAnalysisType(e.target.value as AnalysisType)}
                  className="bg-sz-bg-surface border border-sz-bg-border rounded px-2.5 py-1.5 text-xs font-mono text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                >
                  {ANALYSIS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {isRunning ? (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleCancel}
                    data-testid="ai-run-cancel"
                    icon={<Square className="w-3.5 h-3.5" />}
                  >
                    Cancel Run
                  </Button>
                ) : (
                  <Button
                    variant="commander"
                    size="sm"
                    disabled={!canRequestAgentRun || !incident}
                    onClick={handleRunAnalysis}
                    data-testid="ai-run-start"
                    icon={<Play className="w-3.5 h-3.5" />}
                  >
                    Execute Nemotron Run
                  </Button>
                )}
              </div>
            </div>

            {error && (
              <div
                role="alert"
                data-testid="ai-run-error"
                data-error-kind={error.kind}
                className="p-3 rounded-lg border border-red-700/70 bg-red-950/30 text-xs space-y-1"
              >
                <div className="flex items-center gap-1.5 font-mono font-semibold text-red-300">
                  <AlertTriangle className="w-4 h-4" aria-hidden="true" />
                  <span>{ERROR_TITLES[error.kind]}</span>
                </div>
                <p className="text-slate-300 break-words">{error.message}</p>
                <p className="text-[10px] font-mono text-slate-500">
                  {error.code ? `code ${error.code}` : null}
                  {error.requestId ? ` · request ${error.requestId}` : null}
                  {error.retryAfterSeconds !== null ? ` · retry after ${error.retryAfterSeconds}s` : null}
                </p>
                <p className="text-slate-400">Manual incident workflows remain available.</p>
              </div>
            )}

            {run && snapshot && (
              <div className="space-y-4">
                {/* Run metadata & truthfulness */}
                <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded bg-sz-bg-surface border border-sz-bg-border text-xs font-mono">
                  <div className="flex flex-wrap items-center gap-2">
                    <InferenceBadge snapshot={snapshot} />
                    {snapshot.source === 'EXERCISE_FALLBACK' && <ExerciseBadge />}
                    <span className="text-slate-300 break-all">
                      Model: <strong>{run.model_identifier}</strong>
                    </span>
                  </div>
                  <span data-testid="ai-run-status" data-status={run.status} className="text-slate-300">
                    Run: <strong>{run.status}</strong>
                  </span>
                </div>

                {snapshot.source === 'EXERCISE_FALLBACK' && (
                  <p data-testid="ai-exercise-notice" className="text-[11px] text-amber-300/90 font-mono">
                    EXERCISE SCENARIO — simulated locally, no model was called. {snapshot.fallbackReason}
                  </p>
                )}
                {run.injection_suspected && (
                  <p className="text-[11px] text-amber-300 font-mono flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5" aria-hidden="true" />
                    Possible prompt-injection content was detected in incident data; treat output with caution.
                  </p>
                )}

                {/* Sub-agent pipeline */}
                <section aria-labelledby="ai-pipeline-heading" className="space-y-2">
                  <h4 id="ai-pipeline-heading" className="text-xs font-mono font-bold text-cyan-300 uppercase tracking-wider">
                    Sub-agent pipeline
                  </h4>
                  {run.subagents ? (
                    <SubagentPipeline subagents={run.subagents} reducedMotion={prefersReducedMotion} />
                  ) : (
                    <p data-testid="ai-subagents-unavailable" className="text-[11px] text-slate-400 font-mono">
                      {isTerminalStatus(run.status)
                        ? 'This AI service version does not report sub-agent telemetry.'
                        : 'Waiting for sub-agent telemetry…'}
                    </p>
                  )}
                </section>

                {run.status === 'FAILED' || failedStages.length > 0 ? (
                  <div
                    data-testid="ai-run-failure"
                    className="p-3 rounded-lg border border-red-700/70 bg-red-950/30 text-xs text-red-200 space-y-1"
                  >
                    <p className="font-mono font-semibold">
                      {failedStages.length > 0
                        ? `Sub-agent failure: ${failedStages.map((s) => s.name).join(', ')}`
                        : 'Analysis failed'}
                      {run.error_category ? ` (${run.error_category})` : ''}
                    </p>
                    {run.error_message && <p className="text-slate-300 break-words">{run.error_message}</p>}
                    <p className="text-slate-400">No recommendation is shown for a failed analysis.</p>
                  </div>
                ) : null}
                {(run.status === 'CANCELLED' || run.status === 'EXPIRED') && (
                  <p className="text-xs font-mono text-slate-400">Run {run.status.toLowerCase()}; no recommendation produced.</p>
                )}

                {/* Tool calls */}
                {run.tool_calls.length > 0 && (
                  <div className="p-3 rounded bg-sz-bg-deep border border-sz-bg-border font-mono text-xs space-y-2">
                    <div className="flex items-center gap-1.5 text-slate-400 text-[11px] pb-1 border-b border-sz-bg-border">
                      <Terminal className="w-3.5 h-3.5 text-cyan-400" aria-hidden="true" />
                      <span>ALLOWLISTED READ-ONLY TOOL SEQUENCE ({run.tool_calls.length} steps)</span>
                    </div>
                    <ul className="space-y-1">
                      {run.tool_calls.map((tc) => (
                        <li key={tc.id} className="flex items-center gap-2 text-[11px]">
                          <span className="text-cyan-400 font-bold">{tc.tool_name}()</span>
                          <span className={tc.status === 'OK' ? 'text-emerald-400' : 'text-red-400'}>{tc.status}</span>
                          <span className="text-slate-500">{tc.duration_ms}ms</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Sitrep draft */}
                {run.sitrep ? (
                  <section aria-labelledby="ai-sitrep-heading" className="space-y-1.5">
                    <h4
                      id="ai-sitrep-heading"
                      className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5"
                    >
                      <FileText className="w-4 h-4 text-cyan-400" aria-hidden="true" />
                      Sitrep draft (not sent)
                    </h4>
                    <pre
                      data-testid="ai-sitrep"
                      className="p-3 rounded bg-sz-bg-deep border border-sz-bg-border text-[11px] text-slate-200 whitespace-pre-wrap break-words font-mono"
                    >
                      {run.sitrep}
                    </pre>
                  </section>
                ) : null}

                {/* Pending recommendation */}
                {showRecommendation && run.recommendation && (
                  <RecommendationCard
                    rec={run.recommendation}
                    queued={queuedRecIds.has(run.recommendation.id)}
                    canQueue={can('CREATE_TASK')}
                    onQueue={handleQueueForApproval}
                    queueError={queueError}
                  />
                )}
              </div>
            )}

            {isRunning && !run && (
              <p className="text-xs font-mono text-slate-400 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" aria-hidden="true" /> Submitting analysis request…
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};

interface RecommendationCardProps {
  rec: AIRecommendation;
  queued: boolean;
  canQueue: boolean;
  onQueue: (rec: AIRecommendation) => void;
  queueError: string | null;
}

const RecommendationCard: React.FC<RecommendationCardProps> = ({ rec, queued, canQueue, onQueue, queueError }) => (
  <section
    aria-labelledby="ai-rec-heading"
    data-testid="ai-recommendation"
    data-status={rec.status}
    className="p-3.5 rounded-lg border border-amber-600/60 bg-sz-bg-surface space-y-2"
  >
    <div className="flex items-center justify-between gap-2">
      <h4 id="ai-rec-heading" className="text-xs font-mono font-bold text-amber-300 uppercase tracking-wider flex items-center gap-1.5">
        <Sparkles className="w-4 h-4 text-amber-400" aria-hidden="true" />
        Proposed Mitigation
      </h4>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-950 text-red-300 border border-red-800">{rec.priority}</span>
        <span
          data-testid="ai-recommendation-status"
          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-700"
        >
          {rec.status}
        </span>
      </div>
    </div>
    <p className="text-xs font-semibold text-slate-200 break-words">{rec.title}</p>
    <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap break-words">{rec.description}</p>
    <div className="p-2 rounded bg-sz-bg-base/80 border border-sz-bg-border text-[11px] text-slate-400 font-mono break-words">
      <strong className="text-cyan-300">Rationale:</strong> {rec.rationale}
    </div>
    {rec.uncertainties.length > 0 && (
      <ul className="list-disc pl-5 text-[11px] text-slate-400 space-y-0.5">
        {rec.uncertainties.map((u, i) => (
          <li key={i} className="break-words">
            {u}
          </li>
        ))}
      </ul>
    )}
    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-sz-bg-border text-xs">
      <span data-testid="ai-approval-required" className="font-mono text-amber-300 flex items-center gap-1.5">
        <ShieldAlert className="w-4 h-4" aria-hidden="true" />
        Requires Incident Commander approval
      </span>
      {rec.status !== 'PENDING' ? null : queued ? (
        <span data-testid="ai-recommendation-queued" className="font-mono text-slate-300">
          Queued — awaiting Commander decision on the Tasks board
        </span>
      ) : canQueue ? (
        <Button size="sm" variant="outline" data-testid="ai-recommendation-queue" onClick={() => onQueue(rec)}>
          Send to Commander approval queue
        </Button>
      ) : null}
    </div>
    {queueError && (
      <p role="alert" className="text-[11px] text-red-300">
        {queueError}
      </p>
    )}
  </section>
);
