import React from 'react';
import { useUIStore, ActiveView } from '../../stores/uiStore';
import { useTasks } from '../../hooks/useTasks';
import { useConnection } from '../../hooks/useConnection';
import { useIncidents } from '../../hooks/useIncidents';
import { Activity, Bot, CheckSquare, Database, FileText, LayoutDashboard, MessageSquare, Network, Users } from 'lucide-react';

export const Sidebar: React.FC = () => {
  const currentView = useUIStore((s) => s.currentView);
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const setAIPanelOpen = useUIStore((s) => s.setAIPanelOpen);
  const { awaitingApproval } = useTasks();
  const { messages } = useConnection();
  const { dataScopes } = useIncidents();

  const navItems: { view: ActiveView; label: string; icon: React.ReactNode; badge?: number | string; badgeColor?: string; onClick?: () => void }[] = [
    {
      view: 'COMMAND_CENTER',
      label: 'Command Center',
      icon: <LayoutDashboard className="w-5 h-5" />,
    },
    {
      view: 'DATA_SCOPES',
      label: 'Data Scope Ledger',
      icon: <Database className="w-5 h-5" />,
      badge: dataScopes.length,
      badgeColor: 'bg-cyan-950 text-cyan-400 border border-cyan-800',
    },
    {
      view: 'IMPACT_GRAPH',
      label: 'Impact Graph',
      icon: <Network className="w-5 h-5" />,
    },
    {
      view: 'TASKS_BOARD',
      label: 'Tasks & Approvals',
      icon: <CheckSquare className="w-5 h-5" />,
      badge: awaitingApproval.length > 0 ? awaitingApproval.length : undefined,
      badgeColor: 'bg-amber-500 text-black',
    },
    {
      view: 'COMMUNICATIONS',
      label: 'Out-of-Band Comms',
      icon: <MessageSquare className="w-5 h-5" />,
      badge: messages.length,
      badgeColor: 'bg-sz-bg-border text-slate-300',
    },
    {
      view: 'TEAM_ACCESS',
      label: 'Team & Access Control',
      icon: <Users className="w-5 h-5" />,
    },
    {
      view: 'AUDIT_TIMELINE',
      label: 'Audit & Hash Chain',
      icon: <FileText className="w-5 h-5" />,
    },
    {
      view: 'AI_ASSISTANT',
      label: 'Nemotron',
      icon: <Bot className="w-5 h-5" />,
      badge: 'NVIDIA',
      badgeColor: 'bg-emerald-950 text-emerald-400 border border-emerald-700 font-mono text-[9px]',
      onClick: () => {
        setAIPanelOpen(true);
      },
    },
  ];

  return (
    <aside className="w-64 border-r border-sz-bg-border bg-sz-bg-base flex flex-col justify-between hidden md:flex shrink-0">
      <nav className="p-3 space-y-1" aria-label="Incident Navigation">
        {navItems.map((item) => {
          const isActive = currentView === item.view;
          return (
            <button
              key={item.view}
              onClick={() => {
                if (item.onClick) {
                  item.onClick();
                } else {
                  setCurrentView(item.view);
                }
              }}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-md text-sm font-medium transition-all ${
                isActive
                  ? 'bg-cyan-950/60 text-cyan-300 border border-cyan-500/40 shadow-sm'
                  : 'text-slate-400 hover:text-slate-100 hover:bg-sz-bg-surface'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className={isActive ? 'text-cyan-400' : 'text-slate-400'}>{item.icon}</span>
                <span>{item.label}</span>
              </div>
              {item.badge !== undefined && (
                <span className={`text-[11px] font-mono font-bold px-1.5 py-0.5 rounded-full ${item.badgeColor || 'bg-slate-800 text-slate-300'}`}>
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Out-of-band operational guarantee footer */}
      <div className="p-4 m-3 rounded-lg bg-sz-bg-surface border border-sz-bg-border text-xs text-slate-400 space-y-2">
        <div className="flex items-center gap-2 text-cyan-400 font-mono font-semibold">
          <Activity className="w-4 h-4" />
          <span>INDEPENDENT COLD HOST</span>
        </div>
        <p className="text-[11px] leading-relaxed text-slate-400">
          Operates outside compromised target directory, email, and internal DNS.
        </p>
      </div>
    </aside>
  );
};

