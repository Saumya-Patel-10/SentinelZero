import React, { useState } from 'react';
import { useIncidents } from '../hooks/useIncidents';
import { useAuth } from '../hooks/useAuth';
import { useTeam } from '../hooks/useTeam';
import { useUIStore } from '../stores/uiStore';
import { IncidentLifecycleBar } from '../components/incidents/IncidentLifecycleBar';
import { KPIOverview } from '../components/dashboard/KPIOverview';
import { SeverityBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { CreateIncidentModal } from '../components/incidents/CreateIncidentModal';
import { TaskBoard } from '../components/tasks/TaskBoard';
import { Clock, Database, Network, Plus, ShieldAlert, User, Users } from 'lucide-react';

export const CommandCenterPage: React.FC = () => {
  const { incident } = useIncidents();
  const { users } = useTeam();
  const { isCommander } = useAuth();
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const [createIncidentOpen, setCreateIncidentOpen] = useState(false);

  if (!incident) return null;
  const commander = users.find((user) => user.auth_identity === incident.commander_identity);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Incident Header & Declaration Info */}
      <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <SeverityBadge severity={incident.severity} />
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-sz-bg-base text-cyan-300 border border-sz-bg-border">
              {incident.category}
            </span>
            <span className="text-xs font-mono text-slate-400">INCIDENT ID: {incident.id}</span>
          </div>
          <h1 className="text-xl md:text-2xl font-bold text-slate-100 tracking-tight">
            {incident.title}
          </h1>
          <p className="text-xs md:text-sm text-slate-300 max-w-4xl leading-relaxed">
            {incident.description}
          </p>
          <div className="flex flex-wrap items-center gap-4 text-xs font-mono text-slate-400 pt-1">
            <span className="flex items-center gap-1.5">
              <User className="w-3.5 h-3.5 text-cyan-400" />
              Commander: <strong className="text-slate-200">{commander?.display_name ?? incident.commander_identity}</strong> <span className="text-slate-500">({incident.commander_identity})</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-slate-400" />
              Detected: {new Date(incident.detected_at).toLocaleString()}
            </span>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row md:flex-col gap-2 shrink-0">
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentView('IMPACT_GRAPH')}
              icon={<Network className="w-4 h-4 text-cyan-400" />}
            >
              Impact Graph
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentView('DATA_SCOPES')}
              icon={<Database className="w-4 h-4 text-amber-400" />}
            >
              Scope Ledger
            </Button>
          </div>
          {isCommander && (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentView('TEAM_ACCESS')}
                icon={<Users className="w-4 h-4 text-purple-400" />}
              >
                Access Control
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setCreateIncidentOpen(true)}
                icon={<Plus className="w-4 h-4" />}
              >
                Declare Incident
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Incident Lifecycle Bar */}
      <IncidentLifecycleBar />

      {/* KPI Overview */}
      <KPIOverview />

      {/* Tasks and Approvals */}
      <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-5">
        <TaskBoard />
      </div>

      <CreateIncidentModal
        isOpen={createIncidentOpen}
        onClose={() => setCreateIncidentOpen(false)}
      />
    </div>
  );
};
