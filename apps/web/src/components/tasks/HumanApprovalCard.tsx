import React, { useState } from 'react';
import { Task } from '../../services/contracts';
import { useTasks } from '../../hooks/useTasks';
import { useAuth } from '../../hooks/useAuth';
import { Button } from '../ui/Button';
import { Bot, CheckCircle, Clock, ShieldAlert, XCircle } from 'lucide-react';

interface HumanApprovalCardProps {
  task: Task;
}

export const HumanApprovalCard: React.FC<HumanApprovalCardProps> = ({ task }) => {
  const { approveTask, rejectTask } = useTasks();
  const { isCommander } = useAuth();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleApprove = async () => {
    setErrorMsg(null);
    setLoading(true);
    try {
      await approveTask(task.id);
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Approval failed');
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    setErrorMsg(null);
    setLoading(true);
    try {
      await rejectTask(task.id, 'Rejected by Commander during operational review');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Rejection failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      role="region"
      aria-label={`Pending Approval: ${task.title}`}
      className="rounded-lg border-2 border-amber-500/80 bg-amber-950/20 p-4 space-y-3 relative overflow-hidden shadow-lg shadow-amber-950/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          {task.is_ai_proposed ? (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-500/50 text-[11px] font-mono font-semibold">
              <Bot className="w-3.5 h-3.5 text-cyan-400" />
              <span>NEMOTRON PROPOSAL</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-600/50 text-[11px] font-mono font-semibold">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              <span>CRITICAL ACTION</span>
            </div>
          )}
          <span className="text-xs font-mono text-slate-400">ID: {task.id}</span>
        </div>

        <div className="flex items-center gap-1.5 text-xs font-mono text-amber-400 bg-amber-950/80 px-2 py-0.5 rounded border border-amber-600/60">
          <Clock className="w-3.5 h-3.5" />
          <span>AWAITING APPROVAL</span>
        </div>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-slate-100">{task.title}</h4>
        <p className="text-xs text-slate-300 mt-1 leading-relaxed">{task.description}</p>
      </div>

      <div className="flex items-center justify-between text-xs text-slate-400 border-t border-amber-900/40 pt-2 font-mono">
        <span>Assignee: <strong className="text-slate-200">{task.assigned_name || task.assigned_identity}</strong></span>
        <span>Priority: <strong className="text-red-400">{task.priority}</strong></span>
      </div>

      {errorMsg && (
        <div className="text-xs font-mono text-red-400 bg-red-950/80 border border-red-700 px-2.5 py-1 rounded">
          {errorMsg}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-2 pt-1">
        {isCommander ? (
          <>
            <Button
              size="sm"
              variant="danger"
              loading={loading}
              onClick={handleReject}
              icon={<XCircle className="w-3.5 h-3.5" />}
            >
              Reject
            </Button>
            <Button
              size="sm"
              variant="commander"
              loading={loading}
              onClick={handleApprove}
              icon={<CheckCircle className="w-3.5 h-3.5" />}
            >
              Authorize Task
            </Button>
          </>
        ) : (
          <div className="text-xs text-slate-400 italic">
            Commander authorization required to commit this action.
          </div>
        )}
      </div>
    </div>
  );
};
