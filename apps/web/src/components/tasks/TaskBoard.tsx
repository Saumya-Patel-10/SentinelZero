import React, { useState } from 'react';
import { useTasks } from '../../hooks/useTasks';
import { useAuth } from '../../hooks/useAuth';
import { HumanApprovalCard } from './HumanApprovalCard';
import { Task, TaskStatus } from '../../services/contracts';
import { Button } from '../ui/Button';
import { CreateTaskModal } from './CreateTaskModal';
import { CheckCircle2, Clock, PlayCircle, Plus, ShieldCheck } from 'lucide-react';

export const TaskBoard: React.FC = () => {
  const { tasks, updateTaskStatus } = useTasks();
  const { canMutate } = useAuth();
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const awaitingApproval = tasks.filter((t) => t.approval_status === 'PENDING_APPROVAL');
  const inProgress = tasks.filter((t) => t.status === 'IN_PROGRESS');
  const pending = tasks.filter((t) => t.status === 'PENDING' && t.approval_status !== 'PENDING_APPROVAL');
  const completed = tasks.filter((t) => t.status === 'COMPLETED');

  const handleAdvanceStatus = async (task: Task, nextStatus: TaskStatus) => {
    try {
      await updateTaskStatus(task.id, nextStatus);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header and Add Task */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-100">Incident Action Plan & Task Board</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Real-time responder coordination with strict Commander sign-off on consequential operations.
          </p>
        </div>
        {canMutate && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => setCreateModalOpen(true)}
            icon={<Plus className="w-4 h-4" />}
          >
            Create Task
          </Button>
        )}
      </div>

      {/* Human Approvals Section (Prominently displayed) */}
      {awaitingApproval.length > 0 && (
        <section aria-labelledby="approval-heading" className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping" />
            <h3 id="approval-heading" className="text-sm font-mono font-bold text-amber-300 uppercase tracking-wider">
              Pending Human Commander Approval ({awaitingApproval.length})
            </h3>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {awaitingApproval.map((task) => (
              <HumanApprovalCard key={task.id} task={task} />
            ))}
          </div>
        </section>
      )}

      {/* Kanban Board Columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* PENDING COLUMN */}
        <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-3.5 space-y-3">
          <div className="flex items-center justify-between border-b border-sz-bg-border pb-2">
            <span className="text-xs font-mono font-semibold text-slate-300 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              QUEUED / PENDING ({pending.length})
            </span>
          </div>
          <div className="space-y-2.5">
            {pending.map((t) => (
              <div key={t.id} className="p-3 rounded bg-sz-bg-base border border-sz-bg-border space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono text-slate-400">ID: {t.id}</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sz-bg-surface text-cyan-300 border border-sz-bg-border">
                    {t.priority}
                  </span>
                </div>
                <h4 className="text-sm font-medium text-slate-200">{t.title}</h4>
                <p className="text-xs text-slate-400 line-clamp-2">{t.description}</p>
                <div className="flex items-center justify-between pt-2 border-t border-sz-bg-border/60 text-xs">
                  <span className="text-slate-400">{t.assigned_name || t.assigned_identity}</span>
                  {canMutate && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs text-cyan-400 hover:text-cyan-300"
                      onClick={() => handleAdvanceStatus(t, 'IN_PROGRESS')}
                    >
                      Start &rarr;
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {pending.length === 0 && <p className="text-xs text-slate-400 italic text-center py-4">No queued tasks</p>}
          </div>
        </div>

        {/* IN PROGRESS COLUMN */}
        <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-3.5 space-y-3">
          <div className="flex items-center justify-between border-b border-sz-bg-border pb-2">
            <span className="text-xs font-mono font-semibold text-cyan-400 flex items-center gap-1.5">
              <PlayCircle className="w-3.5 h-3.5 text-cyan-400" />
              IN PROGRESS ({inProgress.length})
            </span>
          </div>
          <div className="space-y-2.5">
            {inProgress.map((t) => (
              <div key={t.id} className="p-3 rounded bg-sz-bg-base border border-cyan-800/40 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono text-cyan-400">ACTIVE</span>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sz-bg-surface text-cyan-300 border border-sz-bg-border">
                    {t.priority}
                  </span>
                </div>
                <h4 className="text-sm font-medium text-slate-200">{t.title}</h4>
                <p className="text-xs text-slate-400 line-clamp-2">{t.description}</p>
                <div className="flex items-center justify-between pt-2 border-t border-sz-bg-border/60 text-xs">
                  <span className="text-slate-400">{t.assigned_name || t.assigned_identity}</span>
                  {canMutate && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs text-emerald-400 hover:text-emerald-300"
                      onClick={() => handleAdvanceStatus(t, 'COMPLETED')}
                    >
                      Complete &#10003;
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {inProgress.length === 0 && (
              <p className="text-xs text-slate-400 italic text-center py-4">No tasks actively running</p>
            )}
          </div>
        </div>

        {/* COMPLETED COLUMN */}
        <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-3.5 space-y-3">
          <div className="flex items-center justify-between border-b border-sz-bg-border pb-2">
            <span className="text-xs font-mono font-semibold text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              VERIFIED COMPLETED ({completed.length})
            </span>
          </div>
          <div className="space-y-2.5">
            {completed.map((t) => (
              <div key={t.id} className="p-3 rounded bg-sz-bg-base/60 border border-emerald-900/30 space-y-1.5 opacity-90">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-mono text-emerald-400 flex items-center gap-1">
                    <ShieldCheck className="w-3 h-3" />
                    VERIFIED
                  </span>
                  <span className="text-[10px] font-mono text-slate-400">v{t.version}</span>
                </div>
                <h4 className="text-sm font-medium text-slate-300 line-through text-opacity-80">{t.title}</h4>
                <p className="text-xs text-slate-400 line-clamp-1">{t.description}</p>
                <div className="text-[11px] text-slate-400 pt-1">
                  Done by: {t.assigned_name || t.assigned_identity}
                </div>
              </div>
            ))}
            {completed.length === 0 && <p className="text-xs text-slate-400 italic text-center py-4">No tasks completed</p>}
          </div>
        </div>
      </div>

      <CreateTaskModal isOpen={createModalOpen} onClose={() => setCreateModalOpen(false)} />
    </div>
  );
};

