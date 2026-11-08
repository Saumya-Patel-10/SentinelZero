import React, { useState } from 'react';
import { useTeam } from '../hooks/useTeam';
import { useAuth } from '../hooks/useAuth';
import { RoleBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Modal';
import { Role } from '../services/contracts';
import { Shield, UserPlus, Users, Trash2, Key, CheckCircle, AlertTriangle } from 'lucide-react';

export const TeamAccessPage: React.FC = () => {
  const { users, currentUser, inviteMember, updateUserRole, removeMember } = useTeam();
  const { isCommander } = useAuth();

  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('RESPONDER');
  const [submitting, setSubmitting] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!displayName.trim() || !email.trim()) return;
    setSubmitting(true);
    setFeedbackMsg(null);
    try {
      await inviteMember({
        displayName: displayName.trim(),
        email: email.trim(),
        role,
      });
      setFeedbackMsg({ type: 'success', text: `Responder ${displayName.trim()} successfully provisioned with ${role} credentials.` });
      setDisplayName('');
      setEmail('');
      setRole('RESPONDER');
      setInviteModalOpen(false);
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to provision member' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRoleChange = async (userId: string, newRole: Role) => {
    try {
      await updateUserRole(userId, newRole);
      setFeedbackMsg({ type: 'success', text: `Role updated to ${newRole}.` });
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to update role' });
    }
  };

  const handleRevoke = async (userId: string, name: string) => {
    if (!window.confirm(`Revoke out-of-band operational access for ${name}?`)) return;
    try {
      await removeMember(userId);
      setFeedbackMsg({ type: 'success', text: `Access revoked for ${name}.` });
    } catch (err: any) {
      setFeedbackMsg({ type: 'error', text: err?.message || 'Failed to revoke access' });
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header & Winstead Requirement Callout */}
      <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-cyan-400" />
            <h1 className="text-xl md:text-2xl font-bold text-slate-100 tracking-tight">
              Access Control & Responder Administration
            </h1>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-950/60 border border-emerald-600/40 text-emerald-400 font-semibold">
              WINSTEAD REQ #2
            </span>
          </div>
          <p className="text-xs md:text-sm text-slate-300 max-w-3xl leading-relaxed">
            Administrative capability to provision, authenticate, and manage authorized individuals on the isolated out-of-band continuity platform.
          </p>
        </div>

        {isCommander && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setInviteModalOpen(true)}
            icon={<UserPlus className="w-4 h-4" />}
          >
            Add Responder / Invite Member
          </Button>
        )}
      </div>

      {feedbackMsg && (
        <div
          className={`p-3.5 rounded-lg border text-xs flex items-center justify-between ${
            feedbackMsg.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-600/50 text-emerald-300'
              : 'bg-red-950/40 border-red-600/50 text-red-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {feedbackMsg.type === 'success' ? <CheckCircle className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span>{feedbackMsg.text}</span>
          </div>
          <button onClick={() => setFeedbackMsg(null)} className="text-slate-400 hover:text-slate-200 text-xs">Dismiss</button>
        </div>
      )}

      {/* Responder Roster Table */}
      <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg overflow-hidden shadow-sm">
        <div className="px-5 py-4 border-b border-sz-bg-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-cyan-400" />
            <h2 className="text-sm font-semibold text-slate-100">Provisioned Incident Responders ({users.length})</h2>
          </div>
          <span className="text-[11px] font-mono text-slate-400">
            Current Authenticated Session: <strong className="text-cyan-300">{currentUser.display_name}</strong> ({currentUser.role})
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-sans">
            <thead className="bg-sz-bg-base text-slate-400 border-b border-sz-bg-border font-mono text-[11px]">
              <tr>
                <th className="p-3">RESPONDER NAME</th>
                <th className="p-3">OUT-OF-BAND IDENTITY</th>
                <th className="p-3">CLEARANCE ROLE</th>
                <th className="p-3">ENROLLED STATUS</th>
                {isCommander && <th className="p-3 text-right">ADMIN ACTIONS</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-sz-bg-border/60">
              {users.map((u) => {
                const isCurrent = u.id === currentUser.id;
                return (
                  <tr key={u.id} className="hover:bg-sz-bg-base/40 transition-colors">
                    <td className="p-3 font-medium text-slate-100 flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-cyan-950/60 border border-cyan-500/40 text-cyan-300 flex items-center justify-center font-mono font-bold text-xs">
                        {u.display_name.charAt(0)}
                      </div>
                      <div>
                        <span>{u.display_name}</span>
                        {isCurrent && (
                          <span className="ml-2 text-[10px] font-mono text-cyan-400 bg-cyan-950/80 px-1.5 py-0.2 rounded border border-cyan-500/30">
                            YOU
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="p-3 font-mono text-slate-300">
                      <div>{u.email}</div>
                      <div className="text-[10px] text-slate-500 truncate max-w-xs">{u.auth_identity}</div>
                    </td>
                    <td className="p-3">
                      {isCommander && !isCurrent ? (
                        <select
                          value={u.role}
                          onChange={(e) => handleRoleChange(u.id, e.target.value as Role)}
                          className="bg-sz-bg-base border border-sz-bg-border rounded px-2 py-1 text-xs font-mono font-semibold text-cyan-300 focus:outline-none"
                        >
                          <option value="COMMANDER">COMMANDER</option>
                          <option value="ANALYST">ANALYST</option>
                          <option value="RESPONDER">RESPONDER</option>
                          <option value="OBSERVER">OBSERVER</option>
                        </select>
                      ) : (
                        <RoleBadge role={u.role} />
                      )}
                    </td>
                    <td className="p-3">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-950/60 border border-emerald-600/40 text-emerald-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        LOCAL FIXTURE
                      </span>
                    </td>
                    {isCommander && (
                      <td className="p-3 text-right">
                        {!isCurrent && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRevoke(u.id, u.display_name)}
                            className="text-red-400 hover:text-red-200 hover:bg-red-950/30"
                            icon={<Trash2 className="w-3.5 h-3.5" />}
                          >
                            Revoke
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Role-Based Security Matrix Reference */}
      <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-5 space-y-3 shadow-sm">
        <div className="flex items-center gap-2">
          <Key className="w-4 h-4 text-cyan-400" />
          <h2 className="text-sm font-semibold text-slate-100">Enforced Platform Authorization Matrix (RBAC)</h2>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          The dashboard operates inside hostile/compromised enterprise conditions. Permissions are cryptographically restricted so observers cannot alter incident status, and only Commanders can sign off on consequential remediations.
        </p>

        <div className="overflow-x-auto pt-2">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-sz-bg-base text-slate-400 border-b border-sz-bg-border text-[10px]">
              <tr>
                <th className="p-2">CAPABILITY</th>
                <th className="p-2 text-center">COMMANDER</th>
                <th className="p-2 text-center">ANALYST</th>
                <th className="p-2 text-center">RESPONDER</th>
                <th className="p-2 text-center">OBSERVER</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sz-bg-border/60">
              <tr>
                <td className="p-2 font-sans font-medium text-slate-200">Add / Invite Individuals (Admin)</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-slate-500">NO</td>
                <td className="p-2 text-center text-slate-500">NO</td>
                <td className="p-2 text-center text-slate-500">NO</td>
              </tr>
              <tr>
                <td className="p-2 font-sans font-medium text-slate-200">Approve Consequential AI Remediation Tasks</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-slate-500">NO</td>
                <td className="p-2 text-center text-slate-500">NO</td>
                <td className="p-2 text-center text-slate-500">NO</td>
              </tr>
              <tr>
                <td className="p-2 font-sans font-medium text-slate-200">Advance NIST Lifecycle Phase</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-slate-500">NO</td>
                <td className="p-2 text-center text-slate-500">NO</td>
              </tr>
              <tr>
                <td className="p-2 font-sans font-medium text-slate-200">Update Data Scope & Compromise Status</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-slate-500">NO</td>
              </tr>
              <tr>
                <td className="p-2 font-sans font-medium text-slate-200">Execute Assigned Field Tasks</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-slate-500">NO</td>
              </tr>
              <tr>
                <td className="p-2 font-sans font-medium text-slate-200">Broadcast Out-of-Band Messages</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-emerald-400 font-bold">YES</td>
                <td className="p-2 text-center text-slate-500">NO</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Responder Modal */}
      <Modal
        isOpen={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
        title="Add Authorized Responder to Platform"
        subtitle="Provision an isolated identity for out-of-band operational command (Winstead Req #2)"
        maxWidth="md"
      >
        <form onSubmit={handleInvite} className="space-y-4 font-sans text-xs">
          <div>
            <label className="block font-mono text-slate-300 mb-1">Full Name</label>
            <input
              type="text"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Alex Rivera"
              className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-slate-100 focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label className="block font-mono text-slate-300 mb-1">Out-of-Band Email / Contact</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="e.g. alex.rivera@sec-response.io"
              className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-slate-100 focus:outline-none focus:border-cyan-500"
            />
            <p className="text-[10px] text-slate-400 mt-1">
              Must not use compromised organization domain (e.g. must be an external out-of-band domain).
            </p>
          </div>

          <div>
            <label className="block font-mono text-slate-300 mb-1">Assigned Security Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-cyan-300 font-mono font-semibold focus:outline-none focus:border-cyan-500"
            >
              <option value="COMMANDER">COMMANDER — Full incident authority & task approvals</option>
              <option value="ANALYST">ANALYST — Forensic triage, graph & scope modifications</option>
              <option value="RESPONDER">RESPONDER — Field action execution & out-of-band comms</option>
              <option value="OBSERVER">OBSERVER — Read-only situational awareness</option>
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-sz-bg-border">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setInviteModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={submitting}
            >
              Provision Responder
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};

