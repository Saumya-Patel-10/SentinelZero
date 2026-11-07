import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { IncidentFormSchema, IncidentFormValues } from '../../services/contracts';
import { useIncidents } from '../../hooks/useIncidents';
import { useAuth } from '../../hooks/useAuth';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { AlertCircle, Plus } from 'lucide-react';

interface CreateIncidentModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CreateIncidentModal: React.FC<CreateIncidentModalProps> = ({ isOpen, onClose }) => {
  const { createNewIncident } = useIncidents();
  const { currentUser, isObserver } = useAuth();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<IncidentFormValues>({
    resolver: zodResolver(IncidentFormSchema),
    defaultValues: {
      title: '',
      description: '',
      category: 'RANSOMWARE',
      severity: 'CRITICAL',
      commander_identity: currentUser.auth_identity,
    },
  });

  const onSubmit = async (values: IncidentFormValues) => {
    try {
      await createNewIncident(values);
      reset();
      onClose();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Declare Incident Record"
      subtitle="Initializes an independent, out-of-band incident workspace with private audit anchoring."
      maxWidth="lg"
    >
      {isObserver ? (
        <div className="p-4 rounded bg-red-950/60 border border-red-800 text-red-200 text-sm flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
          <span>Observers have read-only access and cannot declare new incidents.</span>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-xs font-mono text-slate-300 mb-1">Incident Title *</label>
            <input
              {...register('title')}
              placeholder="e.g. EXERCISE: LockBit Outbreak on Clinical Database"
              className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500"
            />
            {errors.title && <p className="text-xs text-red-400 mt-1">{errors.title.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-mono text-slate-300 mb-1">Threat Category *</label>
              <select
                {...register('category')}
                className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-500"
              >
                <option value="RANSOMWARE">RANSOMWARE</option>
                <option value="EXFILTRATION">EXFILTRATION</option>
                <option value="MALWARE">MALWARE</option>
                <option value="PHISHING">PHISHING</option>
                <option value="DENIAL_OF_SERVICE">DENIAL_OF_SERVICE</option>
                <option value="INSIDER_THREAT">INSIDER_THREAT</option>
                <option value="OTHER">OTHER</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-mono text-slate-300 mb-1">Severity *</label>
              <select
                {...register('severity')}
                className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-500"
              >
                <option value="CRITICAL">CRITICAL</option>
                <option value="HIGH">HIGH</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="LOW">LOW</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-mono text-slate-300 mb-1">Incident Commander Identity *</label>
            <input
              {...register('commander_identity')}
              className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-500 font-mono text-xs"
            />
            {errors.commander_identity && (
              <p className="text-xs text-red-400 mt-1">{errors.commander_identity.message}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-mono text-slate-300 mb-1">Description & Initial Findings *</label>
            <textarea
              {...register('description')}
              rows={4}
              placeholder="Provide evidence summary, symptoms observed, and impacted clinical systems..."
              className="w-full bg-sz-bg-base border border-sz-bg-border rounded p-3 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500"
            />
            {errors.description && <p className="text-xs text-red-400 mt-1">{errors.description.message}</p>}
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-sz-bg-border">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="commander" loading={isSubmitting} icon={<Plus className="w-4 h-4" />}>
              Commit Reducer (Declare)
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
};
