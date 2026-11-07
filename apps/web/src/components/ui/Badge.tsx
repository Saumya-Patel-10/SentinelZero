import React from 'react';
import { VerificationStatus, IncidentSeverity, Role } from '../../services/contracts';
import { AlertTriangle, CheckCircle2, HelpCircle, ShieldAlert, XCircle } from 'lucide-react';

interface StatusBadgeProps {
  status: VerificationStatus;
  size?: 'sm' | 'md';
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, size = 'sm', className = '' }) => {
  const sizeClasses = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm font-medium';

  switch (status) {
    case 'CONFIRMED':
      return (
        <span
          className={`inline-flex items-center gap-1 rounded bg-red-950/80 text-red-400 border border-red-700/60 font-mono ${sizeClasses} ${className}`}
          title="Impact or compromise confirmed by verified evidence"
        >
          <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
          <span>CONFIRMED</span>
        </span>
      );
    case 'SUSPECTED':
      return (
        <span
          className={`inline-flex items-center gap-1 rounded bg-amber-950/80 text-amber-300 border border-amber-600/60 font-mono ${sizeClasses} ${className}`}
          title="Suspected compromise under active investigation"
        >
          <AlertTriangle className="w-3.5 h-3.5 text-amber-300" />
          <span>SUSPECTED</span>
        </span>
      );
    case 'RULED_OUT':
      return (
        <span
          className={`inline-flex items-center gap-1 rounded bg-emerald-950/80 text-emerald-300 border border-emerald-600/60 font-mono ${sizeClasses} ${className}`}
          title="Ruled out / Verified healthy"
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-300" />
          <span>RULED OUT</span>
        </span>
      );
    case 'UNKNOWN':
    default:
      return (
        <span
          className={`inline-flex items-center gap-1 rounded bg-slate-900 text-slate-300 border border-slate-700 font-mono ${sizeClasses} ${className}`}
          title="Status currently unknown - awaiting investigation"
        >
          <HelpCircle className="w-3.5 h-3.5 text-slate-400" />
          <span>UNKNOWN</span>
        </span>
      );
  }
};

interface SeverityBadgeProps {
  severity: IncidentSeverity;
  className?: string;
}

export const SeverityBadge: React.FC<SeverityBadgeProps> = ({ severity, className = '' }) => {
  switch (severity) {
    case 'CRITICAL':
      return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-900/60 text-red-200 border border-red-600 font-mono text-xs font-semibold ${className}`}>
          <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-ping" />
          CRITICAL
        </span>
      );
    case 'HIGH':
      return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded bg-orange-950/60 text-orange-200 border border-orange-600 font-mono text-xs font-semibold ${className}`}>
          HIGH
        </span>
      );
    case 'MEDIUM':
      return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-950/60 text-amber-200 border border-amber-600 font-mono text-xs ${className}`}>
          MEDIUM
        </span>
      );
    case 'LOW':
    default:
      return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-950/60 text-blue-200 border border-blue-700 font-mono text-xs ${className}`}>
          LOW
        </span>
      );
  }
};

interface RoleBadgeProps {
  role: Role;
  className?: string;
}

export const RoleBadge: React.FC<RoleBadgeProps> = ({ role, className = '' }) => {
  switch (role) {
    case 'COMMANDER':
    case 'OWNER':
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded bg-cyan-950/80 text-cyan-300 border border-cyan-500/50 font-mono text-xs font-bold ${className}`}>
          ★ {role}
        </span>
      );
    case 'ANALYST':
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded bg-purple-950/80 text-purple-300 border border-purple-500/50 font-mono text-xs ${className}`}>
          {role}
        </span>
      );
    case 'RESPONDER':
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded bg-indigo-950/80 text-indigo-300 border border-indigo-500/50 font-mono text-xs ${className}`}>
          {role}
        </span>
      );
    case 'OBSERVER':
    default:
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded bg-slate-900 text-slate-400 border border-slate-700 font-mono text-xs ${className}`}>
          {role}
        </span>
      );
  }
};

export const ExerciseBadge: React.FC<{ className?: string }> = ({ className = '' }) => (
  <span
    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500/10 text-amber-400 border border-amber-500/40 text-xs font-mono font-medium tracking-wide ${className}`}
    title="SentinelZero synthetic demonstration scenario - not actual live corporate compromise"
  >
    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
    EXERCISE SCENARIO
  </span>
);
