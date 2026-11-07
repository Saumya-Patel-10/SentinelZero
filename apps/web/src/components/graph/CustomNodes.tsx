import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { StatusBadge, SeverityBadge } from '../ui/Badge';
import { Database, Server, Laptop, ShieldCheck, Users, Activity, HelpCircle, AlertTriangle } from 'lucide-react';
import { VerificationStatus } from '../../services/contracts';

// ASSET NODE
export const AssetNode: React.FC<{ data: any }> = ({ data }) => {
  const getIcon = () => {
    switch (data.category) {
      case 'DATABASE':
        return <Database className="w-4 h-4 text-cyan-400" />;
      case 'IDENTITY_PROVIDER':
        return <ShieldCheck className="w-4 h-4 text-purple-400" />;
      case 'WORKSTATION':
        return <Laptop className="w-4 h-4 text-blue-400" />;
      default:
        return <Server className="w-4 h-4 text-slate-300" />;
    }
  };

  const isConfirmed = data.status === 'CONFIRMED';
  const isSuspected = data.status === 'SUSPECTED';

  return (
    <div
      tabIndex={0}
      role="button"
      aria-label={`Asset: ${data.label}`}
      className={`w-56 p-3 rounded-lg border-2 bg-sz-bg-surface transition-all select-none shadow-md ${
        isConfirmed
          ? 'border-red-600 shadow-red-950/40 ring-1 ring-red-500'
          : isSuspected
          ? 'border-amber-500 shadow-amber-950/40'
          : 'border-sz-bg-border hover:border-slate-500'
      }`}
    >
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-cyan-400" />
      <div className="flex items-center justify-between gap-1 mb-1.5">
        <div className="flex items-center gap-1.5 truncate">
          {getIcon()}
          <span className="text-xs font-mono font-bold text-slate-200 truncate">{data.label}</span>
        </div>
      </div>
      <div className="text-[11px] text-slate-400 truncate mb-2">{data.sublabel}</div>
      <div className="flex items-center justify-between pt-1.5 border-t border-sz-bg-border/60">
        <StatusBadge status={data.status} size="sm" />
        <span className="text-[10px] font-mono text-slate-400">{data.criticality}</span>
      </div>
    </div>
  );
};

// SERVICE NODE
export const ServiceNode: React.FC<{ data: any }> = ({ data }) => {
  return (
    <div
      tabIndex={0}
      role="button"
      aria-label={`Service: ${data.label}`}
      className="w-64 p-3.5 rounded-lg border-2 border-cyan-500/80 bg-sz-bg-surface shadow-lg shadow-cyan-950/30 select-none"
    >
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-cyan-400" />
      <Handle type="source" position={Position.Right} className="w-2.5 h-2.5 bg-cyan-400" />

      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 truncate">
          <Activity className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="text-xs font-semibold text-slate-100 truncate">{data.label}</span>
        </div>
      </div>
      <div className="text-[11px] text-slate-400 mb-2 truncate">{data.sublabel}</div>
      <div className="flex items-center justify-between pt-1.5 border-t border-sz-bg-border/60">
        <StatusBadge status={data.status} size="sm" />
        <SeverityBadge severity={data.criticality} />
      </div>
    </div>
  );
};

// HUMAN GROUP NODE
export const GroupNode: React.FC<{ data: any }> = ({ data }) => {
  return (
    <div
      tabIndex={0}
      role="button"
      aria-label={`Human Group: ${data.label}`}
      className="w-52 p-3 rounded-lg border-2 border-purple-500/80 bg-sz-bg-surface shadow-md select-none"
    >
      <Handle type="target" position={Position.Left} className="w-2.5 h-2.5 bg-purple-400" />
      <div className="flex items-center gap-1.5 mb-1 truncate">
        <Users className="w-4 h-4 text-purple-400 shrink-0" />
        <span className="text-xs font-semibold text-slate-200 truncate">{data.label}</span>
      </div>
      <div className="text-[10px] text-slate-400 mb-2">Affected Operational Unit</div>
      <div className="pt-1.5 border-t border-sz-bg-border/60">
        <StatusBadge status={data.status} size="sm" />
      </div>
    </div>
  );
};

