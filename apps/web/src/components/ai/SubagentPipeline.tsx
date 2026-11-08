import React from 'react';
import { clsx } from 'clsx';
import { AlertOctagon, CheckCircle2, Circle, Loader2, MinusCircle } from 'lucide-react';
import { SUBAGENT_NAMES, type Subagent, type SubagentName, type SubagentStatus } from '../../services/aiClient';

const STAGE_LABELS: Record<SubagentName, string> = {
  triage: 'Triage',
  impact: 'Impact',
  containment: 'Containment',
  communications: 'Communications',
};

const STATUS_STYLES: Record<SubagentStatus, string> = {
  PENDING: 'border-sz-bg-border text-slate-400',
  RUNNING: 'border-cyan-500/70 text-cyan-300',
  COMPLETED: 'border-emerald-600/70 text-emerald-300',
  FAILED: 'border-red-600/80 text-red-300',
  SKIPPED: 'border-slate-700 text-slate-500',
};

const StatusIcon: React.FC<{ status: SubagentStatus; reducedMotion: boolean }> = ({ status, reducedMotion }) => {
  const cls = 'w-4 h-4 shrink-0';
  switch (status) {
    case 'RUNNING':
      return <Loader2 aria-hidden="true" className={clsx(cls, !reducedMotion && 'motion-safe:animate-spin')} />;
    case 'COMPLETED':
      return <CheckCircle2 aria-hidden="true" className={cls} />;
    case 'FAILED':
      return <AlertOctagon aria-hidden="true" className={cls} />;
    case 'SKIPPED':
      return <MinusCircle aria-hidden="true" className={cls} />;
    default:
      return <Circle aria-hidden="true" className={cls} />;
  }
};

interface SubagentPipelineProps {
  subagents: Subagent[];
  reducedMotion: boolean;
}

export const SubagentPipeline: React.FC<SubagentPipelineProps> = ({ subagents, reducedMotion }) => {
  const byName = new Map(subagents.map((s) => [s.name, s]));

  return (
    <ol aria-label="Nemotron sub-agent pipeline" className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="ai-subagent-pipeline">
      {SUBAGENT_NAMES.map((name, index) => {
        const stage = byName.get(name);
        const status: SubagentStatus = stage?.status ?? 'PENDING';
        return (
          <li
            key={name}
            data-testid={`ai-subagent-${name}`}
            data-status={status}
            aria-label={`${STAGE_LABELS[name]} sub-agent: ${status}`}
            className={clsx('rounded-md border bg-sz-bg-deep p-2.5 space-y-1.5', STATUS_STYLES[status])}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-mono font-semibold">
                <StatusIcon status={status} reducedMotion={reducedMotion} />
                <span>
                  {index + 1}. {STAGE_LABELS[name]}
                </span>
              </div>
              <span data-testid={`ai-subagent-${name}-status`} className="text-[10px] font-mono tracking-wider">
                {status}
              </span>
            </div>
            <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-slate-400">
              <div className="flex gap-1">
                <dt>Tool calls</dt>
                <dd className="text-slate-200">{stage?.tool_calls ?? 0}</dd>
              </div>
              <div className="flex gap-1">
                <dt>Model calls</dt>
                <dd className="text-slate-200">{stage?.provider_calls ?? 0}</dd>
              </div>
              <div className="flex gap-1">
                <dt>Latency</dt>
                <dd className="text-slate-200">{stage ? `${Math.round(stage.latency_ms)}ms` : '—'}</dd>
              </div>
            </dl>
            {stage?.summary ? (
              <p data-testid={`ai-subagent-${name}-summary`} className="text-[11px] text-slate-300 leading-snug whitespace-pre-wrap break-words">
                {stage.summary}
              </p>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
};
