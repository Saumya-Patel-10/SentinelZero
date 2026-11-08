import React, { useState } from 'react';
import { useIncidents } from '../hooks/useIncidents';
import { useAuth } from '../hooks/useAuth';
import { DataScope, VerificationStatus } from '../services/contracts';
import { StatusBadge, SeverityBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Database, Lock, Unlock, ShieldAlert, FileText, Plus, AlertTriangle, Scale, CheckCircle2, RefreshCw } from 'lucide-react';

export const DataScopeLedgerPage: React.FC = () => {
  const { dataScopes, assets, updateDataScope, createDataScope } = useIncidents();
  const { canMutate, isObserver } = useAuth();

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState(assets[0]?.id || '');
  const [dataCategory, setDataCategory] = useState<DataScope['data_category']>('PHI');
  const [sensitivity, setSensitivity] = useState<DataScope['sensitivity']>('RESTRICTED');
  const [lockStatus, setLockStatus] = useState<VerificationStatus>('CONFIRMED');
  const [exfilStatus, setExfilStatus] = useState<VerificationStatus>('UNKNOWN');
  const [recordsCount, setRecordsCount] = useState<number>(10000);
  const [evidenceRef, setEvidenceRef] = useState('EVID-MEM-001');
  const [submitting, setSubmitting] = useState(false);

  // Summary Metrics
  const totalEstimatedRecords = dataScopes.reduce((acc, s) => acc + (s.estimated_records || 0), 0);
  const lockedScopesCount = dataScopes.filter((s) => s.lock_status === 'CONFIRMED' || s.lock_status === 'SUSPECTED').length;
  const exfilConfirmedCount = dataScopes.filter((s) => s.exfiltration_status === 'CONFIRMED').length;
  const exfilSuspectedCount = dataScopes.filter((s) => s.exfiltration_status === 'SUSPECTED').length;

  const handleCreateScope = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isObserver) return;
    setSubmitting(true);
    try {
      await createDataScope({
        asset_id: selectedAssetId,
        data_category: dataCategory,
        sensitivity,
        lock_status: lockStatus,
        exfiltration_status: exfilStatus,
        integrity_status: 'SUSPECTED',
        estimated_records: Number(recordsCount),
        confidence: 0.85,
        evidence_reference: evidenceRef,
      });
      setCreateModalOpen(false);
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateLock = async (scopeId: string, current: VerificationStatus) => {
    if (!canMutate) return;
    const next: VerificationStatus = current === 'CONFIRMED' ? 'RULED_OUT' : 'CONFIRMED';
    await updateDataScope(scopeId, { lock_status: next });
  };

  const handleUpdateExfil = async (scopeId: string, current: VerificationStatus) => {
    if (!canMutate) return;
    const next: VerificationStatus =
      current === 'UNKNOWN' ? 'SUSPECTED' : current === 'SUSPECTED' ? 'CONFIRMED' : 'RULED_OUT';
    await updateDataScope(scopeId, { exfiltration_status: next });
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header & Winstead Requirement Callout */}
      <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Database className="w-5 h-5 text-cyan-400" />
            <h1 className="text-xl md:text-2xl font-bold text-slate-100 tracking-tight">
              Compromised Data Scope & Impact Ledger
            </h1>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-600/40 text-emerald-400 font-semibold">
              WINSTEAD REQ #4
            </span>
          </div>
          <p className="text-xs md:text-sm text-slate-300 max-w-3xl leading-relaxed">
            Forensic documentation of data ranges compromised, segregating <strong>Ransomware Encryption (Lock Status)</strong> from <strong>Adversary Exfiltration (Breach Status)</strong> under strict evidentiary standards.
          </p>
        </div>

        {canMutate && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setCreateModalOpen(true)}
            icon={<Plus className="w-4 h-4" />}
          >
            Define New Data Scope
          </Button>
        )}
      </div>

      {/* KPI Cards for Scope */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-4 space-y-1">
          <span className="text-[11px] font-mono text-slate-400 uppercase">Estimated Impacted Records</span>
          <div className="text-2xl font-bold font-mono text-cyan-300">{totalEstimatedRecords.toLocaleString()}</div>
          <span className="text-[10px] text-slate-400">Aggregated across clinical & enterprise stores</span>
        </div>

        <div className="bg-sz-bg-surface border border-red-500/30 rounded-lg p-4 space-y-1">
          <span className="text-[11px] font-mono text-red-300 uppercase">Locked for Ransomware</span>
          <div className="text-2xl font-bold font-mono text-red-400">{lockedScopesCount} Repository Stores</div>
          <span className="text-[10px] text-red-300/80">Encrypted files requiring keys or air-gapped restores</span>
        </div>

        <div className="bg-sz-bg-surface border border-amber-500/30 rounded-lg p-4 space-y-1">
          <span className="text-[11px] font-mono text-amber-300 uppercase">Exfiltration Risk Status</span>
          <div className="text-xl font-bold font-mono text-amber-300">
            {exfilConfirmedCount} Confirmed • {exfilSuspectedCount} Suspected
          </div>
          <span className="text-[10px] text-amber-300/80">Preserves uncertainty until forensic proof verified</span>
        </div>

        <div className="bg-sz-bg-surface border border-purple-500/30 rounded-lg p-4 space-y-1">
          <span className="text-[11px] font-mono text-purple-300 uppercase flex items-center gap-1">
            <Scale className="w-3.5 h-3.5" /> Legal Disclosure Clock
          </span>
          <div className="text-base font-bold font-mono text-purple-200">HIPAA 60d • SEC 4d</div>
          <span className="text-[10px] text-purple-300/80">Mandatory HHS notification threshold exceeded</span>
        </div>
      </div>

      {/* Legal & Regulatory Defense Banner (Winstead Special Feature) */}
      <div className="p-4 rounded-lg bg-gradient-to-r from-purple-950/40 via-sz-bg-surface to-cyan-950/40 border border-purple-500/40 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-3">
          <Scale className="w-5 h-5 text-purple-400 shrink-0" />
          <div>
            <span className="font-semibold text-slate-100">Statutory Data Breach Disclosure Triggers Active:</span>
            <p className="text-slate-300 text-[11px] mt-0.5">
              Over 500 individual patient records affected (&gt;142,000 PHI). Breach Notification Rule requires individual notification without unreasonable delay (max 60 days) and prominent media notice.
            </p>
          </div>
        </div>
        <span className="text-[11px] font-mono font-bold px-2.5 py-1 rounded bg-purple-900/60 border border-purple-400/40 text-purple-200 shrink-0">
          REGULATORY COUNSEL ACTIVE
        </span>
      </div>

      {/* Data Scope Ledger Table */}
      <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-sz-bg-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-slate-100">Documented Scope Definitions ({dataScopes.length})</h2>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            NIST SP 800-61 Rev.3 Scope Boundary Verification
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-sans">
            <thead className="bg-sz-bg-base text-slate-400 border-b border-sz-bg-border font-mono text-[11px]">
              <tr>
                <th className="p-3">DATA CATEGORY & SENSITIVITY</th>
                <th className="p-3">ASSOCIATED TECHNICAL ASSET</th>
                <th className="p-3">EST. RECORDS</th>
                <th className="p-3">RANSOMWARE LOCK STATUS</th>
                <th className="p-3">EXFILTRATION STATUS</th>
                <th className="p-3">EVIDENCE CITATION</th>
                {canMutate && <th className="p-3 text-right">FORENSIC ACTIONS</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-sz-bg-border/60">
              {dataScopes.map((scope) => {
                const asset = assets.find((a) => a.id === scope.asset_id);
                return (
                  <tr key={scope.id} className="hover:bg-sz-bg-base/40 transition-colors">
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-slate-100">{scope.data_category}</span>
                        <SeverityBadge severity={scope.sensitivity as any} />
                      </div>
                      <span className="text-[10px] text-slate-400">Scope ID: {scope.id}</span>
                    </td>
                    <td className="p-3 font-mono">
                      <div className="text-cyan-300 font-semibold">{asset?.name || scope.asset_id}</div>
                      <div className="text-[10px] text-slate-400">{asset?.fqdn || asset?.ip_address || 'Internal Asset'}</div>
                    </td>
                    <td className="p-3 font-mono text-slate-200">
                      <strong>{scope.estimated_records ? scope.estimated_records.toLocaleString() : 'Undetermined'}</strong>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        {scope.lock_status === 'CONFIRMED' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-red-950/70 border border-red-600/60 text-red-300">
                            <Lock className="w-3 h-3 text-red-400" />
                            LOCKED (RANSOMWARE)
                          </span>
                        ) : scope.lock_status === 'SUSPECTED' ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-950/70 border border-amber-600/60 text-amber-300">
                            <Lock className="w-3 h-3 text-amber-400" />
                            SUSPECTED LOCKED
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-950/60 border border-emerald-600/60 text-emerald-400">
                            <Unlock className="w-3 h-3 text-emerald-400" />
                            UNLOCKED / INTACT
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={scope.exfiltration_status} size="sm" />
                        {scope.exfiltration_status === 'UNKNOWN' && (
                          <span className="text-[10px] text-slate-400 italic">Preserving Uncertainty</span>
                        )}
                      </div>
                    </td>
                    <td className="p-3 font-mono text-[11px] text-purple-300">
                      <div className="flex items-center gap-1">
                        <FileText className="w-3.5 h-3.5 text-purple-400" />
                        <span>{scope.evidence_reference || 'Forensic Log'}</span>
                      </div>
                    </td>
                    {canMutate && (
                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleUpdateLock(scope.id, scope.lock_status)}
                            className="text-[11px] h-7 px-2 text-cyan-300"
                            title="Toggle Ransomware Lock Status"
                          >
                            Toggle Lock
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleUpdateExfil(scope.id, scope.exfiltration_status)}
                            className="text-[11px] h-7 px-2 text-amber-300"
                            title="Cycle Exfiltration Assessment"
                          >
                            Cycle Exfil
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Define Scope Modal */}
      <Modal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Define New Compromised Data Scope"
        subtitle="Document compromised data classes and forensic lock/exfiltration status (Winstead Req #4)"
        maxWidth="lg"
      >
        <form onSubmit={handleCreateScope} className="space-y-4 font-sans text-xs">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block font-mono text-slate-300 mb-1">Target Asset</label>
              <select
                value={selectedAssetId}
                onChange={(e) => setSelectedAssetId(e.target.value)}
                className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
              >
                {assets.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.type})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-mono text-slate-300 mb-1">Data Category</label>
              <select
                value={dataCategory}
                onChange={(e) => setDataCategory(e.target.value as any)}
                className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-cyan-300 font-mono focus:outline-none focus:border-cyan-500"
              >
                <option value="PHI">PHI (Protected Health Information - HIPAA)</option>
                <option value="PII">PII (Personally Identifiable Information)</option>
                <option value="FINANCIAL">FINANCIAL (Billing, Credit, Accounts)</option>
                <option value="CREDENTIALS">CREDENTIALS (Kerberos, NTDS, Active Directory)</option>
                <option value="INTERNAL">INTERNAL (Operations & Downtime Procedures)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block font-mono text-slate-300 mb-1">Estimated Record Count</label>
              <input
                type="number"
                min="0"
                required
                value={recordsCount}
                onChange={(e) => setRecordsCount(Number(e.target.value))}
                className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>

            <div>
              <label className="block font-mono text-slate-300 mb-1">Sensitivity Tier</label>
              <select
                value={sensitivity}
                onChange={(e) => setSensitivity(e.target.value as any)}
                className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
              >
                <option value="RESTRICTED">RESTRICTED (Statutory Breaches)</option>
                <option value="CONFIDENTIAL">CONFIDENTIAL (Proprietary)</option>
                <option value="INTERNAL">INTERNAL</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block font-mono text-slate-300 mb-1">Ransomware Lock Status</label>
              <select
                value={lockStatus}
                onChange={(e) => setLockStatus(e.target.value as any)}
                className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-red-400 font-mono font-bold focus:outline-none focus:border-cyan-500"
              >
                <option value="CONFIRMED">CONFIRMED (Encrypted by Ransomware)</option>
                <option value="SUSPECTED">SUSPECTED (Encryption Anomalies)</option>
                <option value="RULED_OUT">RULED OUT (Intact / Decrypted)</option>
                <option value="UNKNOWN">UNKNOWN</option>
              </select>
            </div>

            <div>
              <label className="block font-mono text-slate-300 mb-1">Adversary Exfiltration Status</label>
              <select
                value={exfilStatus}
                onChange={(e) => setExfilStatus(e.target.value as any)}
                className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-amber-400 font-mono font-bold focus:outline-none focus:border-cyan-500"
              >
                <option value="UNKNOWN">UNKNOWN (Preserve Uncertainty)</option>
                <option value="SUSPECTED">SUSPECTED (Egress Spikes Observed)</option>
                <option value="CONFIRMED">CONFIRMED (Verified C2 Data Transfer)</option>
                <option value="RULED_OUT">RULED OUT</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block font-mono text-slate-300 mb-1">Forensic Evidence Citation</label>
            <input
              type="text"
              required
              value={evidenceRef}
              onChange={(e) => setEvidenceRef(e.target.value)}
              placeholder="e.g. EVID-MEM-001 or EVID-PCAP-002"
              className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-slate-100 font-mono focus:outline-none focus:border-cyan-500"
            />
            <p className="text-[10px] text-slate-400 mt-1">
              Strict evidentiary tie: Every scope claim must cite a recorded forensic artifact.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-sz-bg-border">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setCreateModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={submitting}
            >
              Document Scope
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

