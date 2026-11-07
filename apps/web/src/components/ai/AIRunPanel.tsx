import React, { useState } from 'react';
import { aiClient, AIAnalysisResponse } from '../../services/aiClient';
import { useIncidents } from '../../hooks/useIncidents';
import { useTasks } from '../../hooks/useTasks';
import { useAuth } from '../../hooks/useAuth';
import { useUIStore } from '../../stores/uiStore';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { AgentRecommendation } from '../../services/contracts';
import { Activity, Bot, CheckCircle2, ChevronRight, Cpu, Play, ShieldAlert, Sparkles, Terminal } from 'lucide-react';

export const AIRunPanel: React.FC = () => {
  const { incident } = useIncidents();
  const { createTask } = useTasks();
  const { isCommander } = useAuth();
  const isAIPanelOpen = useUIStore((s) => s.isAIPanelOpen);
  const setAIPanelOpen = useUIStore((s) => s.setAIPanelOpen);

  const [scope, setScope] = useState<'ALL' | 'CONTAINMENT_ONLY' | 'CONTINUITY_ONLY'>('ALL');
  const [loading, setLoading] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<AIAnalysisResponse | null>(null);
  const [acceptedRecIds, setAcceptedRecIds] = useState<Set<string>>(new Set());

  const handleRunAnalysis = async () => {
    if (!incident) return;
    setLoading(true);
    try {
      const result = await aiClient.triggerAnalysis({
        incident_id: incident.id,
        scope,
      });
      setAnalysisResult(result);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleApproveRecommendation = async (rec: AgentRecommendation) => {
    if (!isCommander) return;
    try {
      await createTask({
        title: `AI PROPOSAL: ${rec.proposed_task.title}`,
        description: `${rec.description}\n\n[Nemotron Rationale]: ${rec.rationale}`,
        priority: rec.proposed_task.priority,
        assigned_identity: rec.proposed_task.assigned_identity,
        requires_approval: false, // Commander has directly authorized it
      });
      setAcceptedRecIds((prev) => new Set([...prev, rec.id]));
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <Modal
      isOpen={isAIPanelOpen}
      onClose={() => setAIPanelOpen(false)}
      title="NVIDIA Nemotron Incident Copilot"
      subtitle="Autonomous structured reasoning & tool-using agent grounded in NIST SP 800-61 Rev.3. Recommendations remain PENDING until human Commander authorization."
      maxWidth="2xl"
    >
      <div className="space-y-5">
        {/* Run Controls */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-lg bg-sz-bg-base border border-sz-bg-border">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-cyan-400" />
            <div>
              <div className="text-xs font-mono font-semibold text-slate-200">Analysis Scope</div>
              <div className="text-[11px] text-slate-400">Restricts Nemotron tool invocations</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as any)}
              className="bg-sz-bg-surface border border-sz-bg-border rounded px-2.5 py-1.5 text-xs font-mono text-cyan-300 focus:outline-none"
            >
              <option value="ALL">ALL (Containment & Continuity)</option>
              <option value="CONTAINMENT_ONLY">Containment Actions Only</option>
              <option value="CONTINUITY_ONLY">Operational Continuity Only</option>
            </select>
            <Button
              variant="commander"
              size="sm"
              loading={loading}
              onClick={handleRunAnalysis}
              icon={<Play className="w-3.5 h-3.5" />}
            >
              Execute Nemotron Run
            </Button>
          </div>
        </div>

        {/* Results Area */}
        {analysisResult && (
          <div className="space-y-4 animate-fade-in">
            {/* Run Metadata Badge */}
            <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded bg-sz-bg-surface border border-sz-bg-border text-xs font-mono">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-cyan-400" />
                <span className="text-slate-300">Model: <strong>{analysisResult.run.model_identifier}</strong></span>
              </div>
              <div className="flex items-center gap-3 text-slate-400">
                <span>Latency: {analysisResult.latency_ms}ms</span>
                <span className={analysisResult.is_live_nemotron ? 'text-emerald-400' : 'text-amber-400'}>
                  {analysisResult.is_live_nemotron ? '● LIVE NEMOTRON API' : '● SYNTHETIC EXERCISE SIMULATION'}
                </span>
              </div>
            </div>

            {/* Tool Calls Stream */}
            <div className="p-3 rounded bg-sz-bg-deep border border-sz-bg-border font-mono text-xs space-y-2">
              <div className="flex items-center gap-1.5 text-slate-400 text-[11px] pb-1 border-b border-sz-bg-border">
                <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                <span>ALLOWLISTED READ-ONLY TOOL SEQUENCE ({analysisResult.tool_calls.length} steps)</span>
              </div>
              <div className="space-y-1.5">
                {analysisResult.tool_calls.map((tc) => (
                  <div key={tc.id} className="flex items-start gap-2 text-[11px]">
                    <span className="text-cyan-400 font-bold shrink-0">{tc.tool_name}():</span>
                    <span className="text-slate-300 truncate">{tc.output_summary}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Generated Pending Proposals */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-mono font-bold text-amber-300 uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  Proposed Mitigations (Require Human Approval)
                </h4>
                <span className="text-xs text-slate-400">{analysisResult.recommendations.length} items</span>
              </div>

              {analysisResult.recommendations.map((rec) => {
                const isApproved = acceptedRecIds.has(rec.id);
                return (
                  <div
                    key={rec.id}
                    className="p-3.5 rounded-lg border border-sz-bg-border bg-sz-bg-surface hover:border-cyan-600/50 transition-all space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-700/50">
                          {rec.category}
                        </span>
                        <span className="text-xs font-semibold text-slate-200">{rec.title}</span>
                      </div>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-red-950 text-red-300 border border-red-800">
                        {rec.priority}
                      </span>
                    </div>

                    <p className="text-xs text-slate-300 leading-relaxed">{rec.description}</p>

                    <div className="p-2 rounded bg-sz-bg-base/80 border border-sz-bg-border text-[11px] text-slate-400 font-mono">
                      <strong className="text-cyan-300">Grounding Rationale:</strong> {rec.rationale}
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-sz-bg-border text-xs">
                      <span className="text-slate-400 font-mono">
                        Target Assignee: <strong className="text-slate-200">{rec.proposed_task.assigned_identity}</strong>
                      </span>
                      {isApproved ? (
                        <div className="flex items-center gap-1 text-emerald-400 font-mono font-semibold">
                          <CheckCircle2 className="w-4 h-4" />
                          <span>AUTHORIZED & DISPATCHED</span>
                        </div>
                      ) : isCommander ? (
                        <Button
                          size="sm"
                          variant="commander"
                          onClick={() => handleApproveRecommendation(rec)}
                          icon={<CheckCircle2 className="w-3.5 h-3.5" />}
                        >
                          Authorize Action Proposal
                        </Button>
                      ) : (
                        <span className="text-slate-400 italic">Pending Commander Review</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};

