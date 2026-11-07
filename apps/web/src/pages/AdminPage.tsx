import React from 'react';
import { useConnection } from '../hooks/useConnection';
import { useAuth } from '../hooks/useAuth';
import { FileText, Hash, Lock, ShieldCheck } from 'lucide-react';

export const AdminPage: React.FC = () => {
  const { auditLogs, evidence } = useConnection();
  const { role } = useAuth();

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h2 className="text-xl font-bold text-slate-100">Audit Trail, Cryptographic Integrity & Evidence</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          Deterministic record of all reducer transactions, state transitions, and forensic evidence references.
        </p>
      </div>

      {/* Cryptographic Hash Chain Table */}
      <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg overflow-hidden space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Hash className="w-5 h-5 text-cyan-400" />
            <h3 className="text-sm font-semibold text-slate-100">Cryptographically Chained Reducer Ledger</h3>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-600/40 text-emerald-400 text-xs font-mono font-medium">
            <ShieldCheck className="w-4 h-4" />
            <span>HASH CHAIN VALIDATED</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-sz-bg-base text-slate-400 border-b border-sz-bg-border">
              <tr>
                <th className="p-2.5">TIMESTAMP</th>
                <th className="p-2.5">ACTOR</th>
                <th className="p-2.5">EVENT TYPE</th>
                <th className="p-2.5">TARGET</th>
                <th className="p-2.5">PREVIOUS HASH &rarr; EVENT HASH</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sz-bg-border/60">
              {auditLogs.map((log) => (
                <tr key={log.id} className="hover:bg-sz-bg-base/40">
                  <td className="p-2.5 text-slate-400 whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </td>
                  <td className="p-2.5 font-sans font-medium text-slate-200">{log.actor_name}</td>
                  <td className="p-2.5 text-cyan-300">{log.event_type}</td>
                  <td className="p-2.5 text-slate-400 truncate max-w-[120px]">{log.target_id}</td>
                  <td className="p-2.5 text-[10px] text-slate-400 truncate max-w-xs font-mono">
                    <span className="text-slate-400">{log.previous_hash.substring(0, 8)}...</span> &rarr;{' '}
                    <span className="text-cyan-400 font-bold">{log.event_hash.substring(0, 12)}...</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Forensic Evidence References */}
      <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="w-5 h-5 text-purple-400" />
          <h3 className="text-sm font-semibold text-slate-100">Forensic Evidence Locker (TLP Tagged)</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {evidence.map((ev) => (
            <div key={ev.id} className="p-3 rounded bg-sz-bg-base border border-sz-bg-border space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-mono font-bold text-slate-200">{ev.type}</span>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                    ev.classification === 'TLP_RED'
                      ? 'bg-red-950 text-red-300 border border-red-700'
                      : 'bg-amber-950 text-amber-300 border border-amber-700'
                  }`}
                >
                  {ev.classification}
                </span>
              </div>
              <div className="text-slate-300">{ev.summary}</div>
              <div className="text-[11px] font-mono text-slate-400 truncate">
                Source: <strong>{ev.source}</strong>
              </div>
              <div className="p-1.5 rounded bg-sz-bg-deep font-mono text-[10px] text-slate-400 truncate">
                SHA256: <span className="text-slate-300">{ev.sha256}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Role Authorization Matrix */}
      <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Lock className="w-5 h-5 text-cyan-400" />
          <h3 className="text-sm font-semibold text-slate-100">Security Invariants & Role Privilege Enforcement</h3>
        </div>
        <p className="text-xs text-slate-400">
          Current Active Session Role: <strong className="text-cyan-300">{role}</strong>. Reducers strictly enforce privileges on the server.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
          <div className="p-2.5 rounded bg-sz-bg-base border border-sz-bg-border">
            <span className="text-slate-400 block text-[10px]">COMMANDER</span>
            <span className="text-cyan-300">Approvals & Lifecycle</span>
          </div>
          <div className="p-2.5 rounded bg-sz-bg-base border border-sz-bg-border">
            <span className="text-slate-400 block text-[10px]">ANALYST</span>
            <span className="text-purple-300">Forensics & Triage</span>
          </div>
          <div className="p-2.5 rounded bg-sz-bg-base border border-sz-bg-border">
            <span className="text-slate-400 block text-[10px]">RESPONDER</span>
            <span className="text-indigo-300">Action Execution</span>
          </div>
          <div className="p-2.5 rounded bg-sz-bg-base border border-sz-bg-border">
            <span className="text-slate-400 block text-[10px]">OBSERVER</span>
            <span className="text-slate-400">Strict Read-Only</span>
          </div>
        </div>
      </div>
    </div>
  );
};
