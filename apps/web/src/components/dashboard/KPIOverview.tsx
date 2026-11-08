import React from 'react';
import { useIncidents } from '../../hooks/useIncidents';
import { useTasks } from '../../hooks/useTasks';
import { useGraphStore } from '../../stores/graphStore';
import { useUIStore } from '../../stores/uiStore';
import { AnimatedStatCard } from './AnimatedStatCard';
import { Activity, AlertTriangle, CheckSquare, ShieldAlert, Users } from 'lucide-react';

export const KPIOverview: React.FC = () => {
  const { impacts } = useIncidents();
  const { awaitingApproval } = useTasks();
  const { summary } = useGraphStore();
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const serviceLabels = [...new Set(impacts.map((impact) => impact.service_id))].slice(0, 3);
  const groupLabels = [...new Set(impacts.flatMap((impact) => impact.affected_groups))].slice(0, 3);

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
      <AnimatedStatCard
        title="CONFIRMED COMPROMISED"
        value={summary.compromisedConfirmed}
        change="Verified by forensic evidence"
        icon={ShieldAlert}
        tone="red"
        onClick={() => setCurrentView('IMPACT_GRAPH')}
      />

      <AnimatedStatCard
        title="SUSPECTED COMPROMISED"
        value={summary.compromisedSuspected}
        change="Under active forensic triage"
        icon={AlertTriangle}
        tone="amber"
        onClick={() => setCurrentView('IMPACT_GRAPH')}
      />

      <AnimatedStatCard
        title="SERVICES DISRUPTED"
        value={impacts.length}
        change={serviceLabels.join(', ') || 'None recorded'}
        icon={Activity}
        tone="cyan"
        onClick={() => setCurrentView('IMPACT_GRAPH')}
      />

      <AnimatedStatCard
        title="AFFECTED HUMAN GROUPS"
        value={summary.humanGroupsAffected}
        change={groupLabels.join(', ') || 'None recorded'}
        icon={Users}
        tone="violet"
        onClick={() => setCurrentView('IMPACT_GRAPH')}
      />

      <AnimatedStatCard
        title="PENDING APPROVALS"
        value={awaitingApproval.length}
        change="Consequential task queue"
        icon={CheckSquare}
        tone="amber"
        onClick={() => setCurrentView('TASKS_BOARD')}
      />
    </div>
  );
};
