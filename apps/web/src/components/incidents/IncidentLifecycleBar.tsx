import React, { useState } from 'react';
import { useIncidents } from '../../hooks/useIncidents';
import { useAuth } from '../../hooks/useAuth';
import { IncidentStatus, ALLOWED_STATUS_TRANSITIONS } from '../../services/contracts';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { CheckCircle2, ChevronRight, Lock, RotateCcw } from 'lucide-react';

const ALL_STATUSES: IncidentStatus[] = [
  'REPORTED',
  'TRIAGING',
  'INVESTIGATING',
  'CONTAINING',
  'CONTAINED',
  'RECOVERING',
  'RESOLVED',
  'CLOSED',
];

export const IncidentLifecycleBar: React.FC = () => {
  const { incident, transitionStatus } = useIncidents();
  const { isCommander, isObserver } = useAuth();
  const [reopenModalOpen, setReopenModalOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!incident) return null;

  const currentStatus = incident.status;
  const currentIndex = ALL_STATUSES.indexOf(currentStatus);
  const allowedNext = ALLOWED_STATUS_TRANSITIONS[currentStatus] || [];

  const handleStatusClick = async (targetStatus: IncidentStatus) => {
    setErrorMessage(null);
    if (isObserver) {
      setErrorMessage('ACCESS_DENIED: Observers cannot change incident lifecycle state.');
      return;
    }

    if (currentStatus === 'CLOSED' && targetStatus === 'TRIAGING') {
      if (!isCommander) {
        setErrorMessage('ACCESS_DENIED: Reopening a closed incident strictly requires COMMANDER authorization.');
        return;
      }
      setReopenModalOpen(true);
      return;
    }

    if (!allowedNext.includes(targetStatus)) {
      setErrorMessage(`INVALID_TRANSITION: Cannot transition directly from ${currentStatus} to ${targetStatus}.`);
      return;
    }

    try {
      await transitionStatus(targetStatus);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to transition status');
    }
  };

  const handleConfirmReopen = async () => {
    try {
      await transitionStatus('TRIAGING', reopenReason);
      setReopenModalOpen(false);
      setReopenReason('');
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Reopen validation failed');
    }
  };

  return (
    <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono uppercase tracking-wider text-slate-400">
          Incident Lifecycle Progression
        </span>
        <span className="text-xs font-mono text-cyan-400">
          Current State: <strong>{currentStatus}</strong> (v{incident.version})
        </span>
      </div>

      {/* Stepper Bar */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-1.5" role="list">
        {ALL_STATUSES.map((status, idx) => {
          const isCurrent = status === currentStatus;
          const isPast = idx < currentIndex;
          const isAllowed = allowedNext.includes(status);

          let bgClass = 'bg-sz-bg-base/80 text-slate-400 border-sz-bg-border/60 hover:border-slate-600';
          if (isCurrent) {
            bgClass = 'bg-cyan-950 text-cyan-300 border-cyan-400 ring-1 ring-cyan-400 font-bold';
          } else if (isPast) {
            bgClass = 'bg-slate-900/90 text-emerald-400 border-emerald-900/60';
          } else if (isAllowed) {
            bgClass = 'bg-sz-bg-elevated text-slate-200 border-cyan-600/60 hover:bg-cyan-950/40 cursor-pointer';
          }

          return (
            <button
              key={status}
              onClick={() => handleStatusClick(status)}
              disabled={!isAllowed && !isCurrent}
              className={`flex items-center justify-between p-2 rounded border text-xs font-mono transition-all text-left ${bgClass} ${
                !isAllowed && !isCurrent ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              title={
                isCurrent
                  ? 'Current state'
                  : isAllowed
                  ? `Click to transition to ${status}`
                  : `Disallowed transition from ${currentStatus}`
              }
            >
              <div className="truncate">
                <div className="text-[10px] text-slate-400">0{idx + 1}</div>
                <div className="truncate">{status}</div>
              </div>
              {isPast ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              ) : isAllowed ? (
                <ChevronRight className="w-3.5 h-3.5 text-cyan-400 shrink-0 animate-pulse" />
              ) : null}
            </button>
          );
        })}
      </div>

      {errorMessage && (
        <div className="text-xs font-mono text-red-400 bg-red-950/40 border border-red-800/60 px-3 py-1.5 rounded flex items-center gap-2">
          <Lock className="w-3.5 h-3.5 text-red-400 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Commander Re-open Confirmation Modal */}
      <Modal
        isOpen={reopenModalOpen}
        onClose={() => setReopenModalOpen(false)}
        title="Commander Authorization: Reopen Incident"
        subtitle="Mandatory audit trail requires explicit commander justification to reopen a closed incident."
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-mono text-slate-300 mb-1">
              Commander Justification / Newly Discovered Evidence:
            </label>
            <textarea
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="e.g., Secondary ransomware beacon detected on workstation subnet after closure..."
              className="w-full h-28 bg-sz-bg-base border border-sz-bg-border rounded p-2.5 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReopenModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="commander"
              onClick={handleConfirmReopen}
              disabled={reopenReason.trim().length < 10}
              icon={<RotateCcw className="w-4 h-4" />}
            >
              Authorize Reopening
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
