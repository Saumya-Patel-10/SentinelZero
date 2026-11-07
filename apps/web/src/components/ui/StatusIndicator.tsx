import React from 'react';
import { useConnection } from '../../hooks/useConnection';
import { Activity, Radio, Wifi, WifiOff } from 'lucide-react';

export const StatusIndicator: React.FC = () => {
  const { connectionStatus, isLiveConnection, lastSyncTime, latencyMs, toggleSimulatedConnection } = useConnection();

  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'CONNECTED':
        return 'text-emerald-400 bg-emerald-950/60 border-emerald-600/40';
      case 'CONNECTING':
      case 'RECONNECTING':
        return 'text-amber-400 bg-amber-950/60 border-amber-600/40';
      case 'DISCONNECTED':
      case 'ERROR':
      default:
        return 'text-red-400 bg-red-950/60 border-red-600/40';
    }
  };

  const formattedTime = new Date(lastSyncTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="flex items-center gap-3 text-xs font-mono">
      {/* Simulation / Live indicator */}
      <div
        className="flex items-center gap-1.5 px-2 py-1 rounded border bg-sz-bg-surface border-sz-bg-border text-slate-300"
        title={isLiveConnection ? "Connected to SpacetimeDB WebSocket" : "Running on reactive in-memory exercise state"}
      >
        <Radio className={`w-3 h-3 ${isLiveConnection ? 'text-cyan-400 animate-pulse' : 'text-slate-400'}`} />
        <span className="text-[11px]">{isLiveConnection ? 'SPACETIMEDB LIVE' : 'EXERCISE REPLAY'}</span>
      </div>

      {/* Latency badge */}
      <div className="hidden sm:flex items-center gap-1 px-2 py-1 rounded border bg-sz-bg-surface border-sz-bg-border text-slate-400">
        <Activity className="w-3 h-3 text-cyan-400" />
        <span>{latencyMs}ms</span>
      </div>

      {/* Connection State button (clickable for testing disconnected state) */}
      <button
        onClick={toggleSimulatedConnection}
        title="Click to test network disconnected / reconnected handling"
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded border transition-all ${getStatusColor()} hover:opacity-80 active:scale-95`}
      >
        {connectionStatus === 'CONNECTED' ? (
          <Wifi className="w-3.5 h-3.5 text-emerald-400" />
        ) : (
          <WifiOff className="w-3.5 h-3.5 text-red-400 animate-pulse" />
        )}
        <span className="font-semibold uppercase tracking-wider text-[11px]">{connectionStatus}</span>
        <span className="hidden md:inline text-slate-400 font-normal">| {formattedTime}</span>
      </button>
    </div>
  );
};
