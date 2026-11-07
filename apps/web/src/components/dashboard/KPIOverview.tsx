import React from 'react';
import { useIncidents } from '../../hooks/useIncidents';
import { useTasks } from '../../hooks/useTasks';
import { useGraphStore } from '../../stores/graphStore';
import { Activity, AlertTriangle, CheckSquare, Database, ShieldAlert, Users } from 'lucide-react';

export const KPIOverview: React.FC = () => {
  const { assets, impacts } = useIncidents();
  const { awaitingApproval } = useTasks();
  const { summary } = useGraphStore();

  const kpis = [
    {
      label: 'CONFIRMED COMPROMISED',
      value: summary.compromisedConfirmed,
      icon: <ShieldAlert className="w-5 h-5 text-red-400" />,
      sub: 'Verified by forensic evidence',
      color: 'border-red-600/60 bg-red-950/20 text-red-400',
    },
    {
      label: 'SUSPECTED COMPROMISED',
      value: summary.compromisedSuspected,
      icon: <AlertTriangle className="w-5 h-5 text-amber-400" />,
      sub: 'Under active triage',
      color: 'border-amber-600/60 bg-amber-950/20 text-amber-400',
    },
    {
      label: 'SERVICES DISRUPTED',
      value: impacts.length,
      icon: <Activity className="w-5 h-5 text-cyan-400" />,
      sub: 'EHR, Imaging, Pharmacy',
      color: 'border-cyan-600/60 bg-cyan-950/20 text-cyan-400',
    },
    {
      label: 'AFFECTED HUMAN GROUPS',
      value: summary.humanGroupsAffected,
      icon: <Users className="w-5 h-5 text-purple-400" />,
      sub: 'Emergency, ICU, Surgery',
      color: 'border-purple-600/60 bg-purple-950/20 text-purple-400',
    },
    {
      label: 'PENDING APPROVALS',
      value: awaitingApproval.length,
      icon: <CheckSquare className="w-5 h-5 text-amber-300" />,
      sub: 'Consequential tasks',
      color: 'border-amber-500/80 bg-amber-950/30 text-amber-300 ring-1 ring-amber-500/40',
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3.5">
      {kpis.map((kpi, idx) => (
        <div
          key={idx}
          className={`p-4 rounded-lg border flex flex-col justify-between ${kpi.color} transition-all shadow-sm`}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-mono tracking-wider font-semibold opacity-90">{kpi.label}</span>
            {kpi.icon}
          </div>
          <div className="text-3xl font-mono font-bold tracking-tight">{kpi.value}</div>
          <div className="text-[11px] text-slate-400 mt-1 truncate">{kpi.sub}</div>
        </div>
      ))}
    </div>
  );
};

