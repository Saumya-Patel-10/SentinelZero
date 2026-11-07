import React from 'react';
import { useUIStore } from '../stores/uiStore';
import { TopBar } from '../components/layout/TopBar';
import { Sidebar } from '../components/layout/Sidebar';
import { ConnectionBanner } from '../components/layout/ConnectionBanner';
import { CommandCenterPage } from '../pages/CommandCenterPage';
import { ImpactGraphPage } from '../pages/ImpactGraphPage';
import { TasksPage } from '../pages/TasksPage';
import { CommunicationsPage } from '../pages/CommunicationsPage';
import { AdminPage } from '../pages/AdminPage';
import { AIRunPanel } from '../components/ai/AIRunPanel';
import { CheckSquare, LayoutDashboard, MessageSquare, Network, Shield } from 'lucide-react';

export const AppRouter: React.FC = () => {
  const currentView = useUIStore((s) => s.currentView);
  const setCurrentView = useUIStore((s) => s.setCurrentView);

  const renderActiveView = () => {
    switch (currentView) {
      case 'COMMAND_CENTER':
        return <CommandCenterPage />;
      case 'IMPACT_GRAPH':
        return <ImpactGraphPage />;
      case 'TASKS_BOARD':
        return <TasksPage />;
      case 'COMMUNICATIONS':
        return <CommunicationsPage />;
      case 'AUDIT_TIMELINE':
        return <AdminPage />;
      case 'AI_ASSISTANT':
        return <CommandCenterPage />;
      default:
        return <CommandCenterPage />;
    }
  };

  return (
    <div className="min-h-screen bg-sz-bg-deep flex flex-col text-slate-100 selection:bg-cyan-500 selection:text-black">
      <TopBar />
      <ConnectionBanner />

      <div className="flex-1 flex overflow-hidden">
        <Sidebar />

        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 bg-sz-bg-base/60">
          <div className="max-w-7xl mx-auto">{renderActiveView()}</div>
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar */}
      <nav aria-label="Mobile Navigation" className="md:hidden border-t border-sz-bg-border bg-sz-bg-surface px-4 py-2 flex items-center justify-around sticky bottom-0 z-40">
        <button
          onClick={() => setCurrentView('COMMAND_CENTER')}
          className={`flex flex-col items-center gap-1 text-[10px] font-mono ${
            currentView === 'COMMAND_CENTER' ? 'text-cyan-400' : 'text-slate-400'
          }`}
        >
          <LayoutDashboard className="w-4 h-4" />
          <span>Command</span>
        </button>
        <button
          onClick={() => setCurrentView('IMPACT_GRAPH')}
          className={`flex flex-col items-center gap-1 text-[10px] font-mono ${
            currentView === 'IMPACT_GRAPH' ? 'text-cyan-400' : 'text-slate-400'
          }`}
        >
          <Network className="w-4 h-4" />
          <span>Graph</span>
        </button>
        <button
          onClick={() => setCurrentView('TASKS_BOARD')}
          className={`flex flex-col items-center gap-1 text-[10px] font-mono ${
            currentView === 'TASKS_BOARD' ? 'text-cyan-400' : 'text-slate-400'
          }`}
        >
          <CheckSquare className="w-4 h-4" />
          <span>Tasks</span>
        </button>
        <button
          onClick={() => setCurrentView('COMMUNICATIONS')}
          className={`flex flex-col items-center gap-1 text-[10px] font-mono ${
            currentView === 'COMMUNICATIONS' ? 'text-cyan-400' : 'text-slate-400'
          }`}
        >
          <MessageSquare className="w-4 h-4" />
          <span>Comms</span>
        </button>
      </nav>

      <AIRunPanel />
    </div>
  );
};

