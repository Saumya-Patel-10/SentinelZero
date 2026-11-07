import React, { useState } from 'react';
import { NormalizedGraphNode } from '../../services/graphTransform';
import { useIncidents } from '../../hooks/useIncidents';
import { useAuth } from '../../hooks/useAuth';
import { StatusBadge, SeverityBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { VerificationStatus } from '../../services/contracts';
import { Activity, Database, Users, X } from 'lucide-react';

interface NodeDetailDrawerProps {
  node: NormalizedGraphNode | null;
  onClose: () => void;
}

export const NodeDetailDrawer: React.FC<NodeDetailDrawerProps> = ({ node, onClose }) => {
  const { updateAsset, dataScopes } = useIncidents();
  const { canMutate } = useAuth();
  const [updating, setUpdating] = useState(false);

  if (!node) return null;

  const isAsset = node.type === 'ASSET';
  const isService = node.type === 'SERVICE';
  const isGroup = node.type === 'AFFECTED_GROUP';

  // Find data scope for asset
  const matchingScope = isAsset ? dataScopes.find((d) => d.asset_id === node.id) : null;

  const handleUpdateStatus = async (status: VerificationStatus) => {
    if (!isAsset || !canMutate) return;
    setUpdating(true);
    try {
      await updateAsset(node.id, { compromise_status: status });
    } catch (err) {
      console.error(err);
    } finally {
      setUpdating(false);
    }
  };

  const ipText = typeof node.details.ip_address === 'string' ? node.details.ip_address : 'Unassigned';
  const fqdnText = typeof node.details.fqdn === 'string' ? node.details.fqdn : 'None';

  return (
    <aside
      aria-label="Node Details"
      className="w-80 md:w-96 bg-sz-bg-surface border-l border-sz-bg-border h-full flex flex-col justify-between shadow-2xl glass-panel-elevated animate-fade-in z-30"
    >
      <div className="p-4 border-b border-sz-bg-border flex items-center justify-between">
        <div className="flex items-center gap-2 truncate">
          {isAsset && <Database className="w-5 h-5 text-cyan-400 shrink-0" />}
          {isService && <Activity className="w-5 h-5 text-cyan-400 shrink-0" />}
          {isGroup && <Users className="w-5 h-5 text-purple-400 shrink-0" />}
          <div className="truncate">
            <h3 className="text-sm font-bold text-slate-100 truncate">{node.label}</h3>
            <span className="text-[10px] font-mono text-slate-400">{node.type} • ID: {node.id}</span>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded text-slate-400 hover:text-slate-100 hover:bg-sz-bg-elevated"
          aria-label="Close drawer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs font-sans">
        {/* Verification Status */}
        <div className="p-3 rounded-lg bg-sz-bg-base border border-sz-bg-border space-y-1.5">
          <div className="text-[11px] font-mono text-slate-400 uppercase">Verification Assessment</div>
          <div className="flex items-center gap-2">
            <StatusBadge status={node.status} size="md" />
            {node.criticality && <SeverityBadge severity={node.criticality as any} />}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">
            Status strictly derived from verified forensic artifacts. Unverified hypotheses remain flagged as SUSPECTED or UNKNOWN.
          </p>
        </div>

        {/* Asset Details */}
        {isAsset && (
          <div className="space-y-3">
            <div className="text-xs font-mono text-cyan-400 font-bold uppercase tracking-wider">
              Asset Attributes
            </div>
            <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
              <div className="p-2 rounded bg-sz-bg-base border border-sz-bg-border">
                <span className="text-slate-400 block text-[10px]">CATEGORY</span>
                <span className="text-slate-200">{node.category}</span>
              </div>
              <div className="p-2 rounded bg-sz-bg-base border border-sz-bg-border">
                <span className="text-slate-400 block text-[10px]">AVAILABILITY</span>
                <span className="text-slate-200">{node.availabilityStatus || 'UNKNOWN'}</span>
              </div>
              <div className="p-2 rounded bg-sz-bg-base border border-sz-bg-border col-span-2">
                <span className="text-slate-400 block text-[10px]">IP / FQDN</span>
                <span className="text-slate-200">{ipText} • {fqdnText}</span>
              </div>
            </div>

            {/* Data Scope & Exfiltration Uncertainty */}
            {matchingScope && (
              <div className="p-3 rounded-lg bg-sz-bg-base border border-amber-600/40 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-amber-300 font-bold text-[11px]">DATA SCOPE / PHI</span>
                  <span className="text-[10px] font-mono text-slate-400">{matchingScope.data_category}</span>
                </div>
                <div className="text-xs text-slate-300">
                  Est. Affected Records: <strong>{matchingScope.estimated_records.toLocaleString()}</strong>
                </div>
                <div className="flex items-center justify-between text-[11px] font-mono pt-1 border-t border-sz-bg-border">
                  <span className="text-slate-400">Lock Status: <strong className="text-red-400">{matchingScope.lock_status}</strong></span>
                  <span className="text-slate-400">Exfil: <strong className="text-amber-400">{matchingScope.exfiltration_status}</strong></span>
                </div>
                <div className="text-[10px] text-amber-400/90 italic">
                  Note: Exfiltration is marked {matchingScope.exfiltration_status}; no premature breach conclusions asserted.
                </div>
              </div>
            )}

            {/* Quick Status Override (Live Reducer) */}
            {canMutate && (
              <div className="pt-2 border-t border-sz-bg-border space-y-2">
                <span className="text-xs font-mono text-slate-300 block">Forensic Status Update:</span>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={updating}
                    onClick={() => handleUpdateStatus('CONFIRMED')}
                  >
                    Confirm Impact
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={updating}
                    onClick={() => handleUpdateStatus('SUSPECTED')}
                  >
                    Set Suspected
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={updating}
                    onClick={() => handleUpdateStatus('RULED_OUT')}
                  >
                    Rule Out
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={updating}
                    onClick={() => handleUpdateStatus('UNKNOWN')}
                  >
                    Set Unknown
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Service Details */}
        {isService && (
          <div className="space-y-3">
            <div className="text-xs font-mono text-cyan-400 font-bold uppercase tracking-wider">
              Operational Disruption
            </div>
            <div className="p-3 rounded bg-sz-bg-base border border-sz-bg-border text-slate-300 leading-relaxed text-xs">
              {String(node.details.description || '')}
            </div>
            <div className="space-y-1.5">
              <span className="text-[11px] font-mono text-slate-400">Directly Disrupted Teams:</span>
              <div className="flex flex-wrap gap-1.5">
                {((node.details.affected_groups as string[]) || []).map((grp) => (
                  <span key={grp} className="px-2 py-0.5 rounded bg-sz-bg-elevated border border-sz-bg-border text-slate-200 text-xs">
                    {grp}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Human Group Details */}
        {isGroup && (
          <div className="space-y-3">
            <div className="text-xs font-mono text-purple-400 font-bold uppercase tracking-wider">
              Continuity Impact
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Operational unit is operating under emergency downtime procedures due to dependent service disruption.
            </p>
            <div className="p-2.5 rounded bg-sz-bg-base border border-sz-bg-border text-[11px] text-slate-400">
              Personal harm is not inferred from service dependency alone. Triage and bedside monitoring protocols remain in manual mode.
            </div>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-sz-bg-border bg-sz-bg-base flex justify-end">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close Inspector
        </Button>
      </div>
    </aside>
  );
};
