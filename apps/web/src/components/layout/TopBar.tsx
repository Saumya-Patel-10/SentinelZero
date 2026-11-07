import React from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useUIStore } from '../../stores/uiStore';
import { StatusIndicator } from '../ui/StatusIndicator';
import { ExerciseBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Role } from '../../services/contracts';
import { Bot, Shield, User } from 'lucide-react';

export const TopBar: React.FC = () => {
  const { currentUser, role, switchRole } = useAuth();
  const setAIPanelOpen = useUIStore((s) => s.setAIPanelOpen);

  const roles: Role[] = ['COMMANDER', 'ANALYST', 'RESPONDER', 'OBSERVER'];

  return (
    <header className="h-16 border-b border-sz-bg-border bg-sz-bg-surface/90 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between sticky top-0 z-40">
      {/* Brand & Exercise Flag */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-cyan-500 to-blue-700 flex items-center justify-center shadow-lg shadow-cyan-950/50 border border-cyan-400/30">
            <Shield className="w-5 h-5 text-black stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-base font-bold tracking-wider text-slate-100">SENTINEL<span className="text-cyan-400">ZERO</span></span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-sz-bg-border text-slate-400">v1.0</span>
            </div>
            <p className="text-[11px] text-slate-400 hidden lg:block leading-tight">When systems fail, command continues.</p>
          </div>
        </div>

        <ExerciseBadge className="hidden md:inline-flex" />
      </div>

      {/* Center/Right Actions: AI Trigger, Role Emulation & Live Connection */}
      <div className="flex items-center gap-3">
        {/* Nemotron AI Trigger */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAIPanelOpen(true)}
          className="border-cyan-500/50 bg-cyan-950/20 text-cyan-300 hover:bg-cyan-900/30"
          icon={<Bot className="w-4 h-4 text-cyan-400" />}
        >
          <span className="hidden sm:inline">AI Incident Copilot</span>
          <span className="sm:hidden">AI</span>
        </Button>

        {/* Role Selector (Demo & Security verification) */}
        <div className="flex items-center gap-1.5 bg-sz-bg-base border border-sz-bg-border rounded px-2 py-1">
          <User className="w-3.5 h-3.5 text-slate-400 hidden sm:block" />
          <span className="text-xs text-slate-400 hidden sm:inline">Role:</span>
          <select
            value={role}
            onChange={(e) => switchRole(e.target.value as Role)}
            className="bg-transparent text-xs font-mono font-semibold text-cyan-300 focus:outline-none cursor-pointer"
            aria-label="Active Security Role"
          >
            {roles.map((r) => (
              <option key={r} value={r} className="bg-sz-bg-surface text-slate-200">
                {r}
              </option>
            ))}
          </select>
        </div>

        {/* Connection status and Latency */}
        <StatusIndicator />
      </div>
    </header>
  );
};

