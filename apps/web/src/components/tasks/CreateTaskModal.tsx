import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { TaskFormSchema, TaskFormValues } from '../../services/contracts';
import { useTasks } from '../../hooks/useTasks';
import { useAuth } from '../../hooks/useAuth';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Plus } from 'lucide-react';

interface CreateTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const CreateTaskModal: React.FC<CreateTaskModalProps> = ({ isOpen, onClose }) => {
  const { createTask } = useTasks();
  const { availableUsers } = useAuth();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<TaskFormValues>({
    resolver: zodResolver(TaskFormSchema),
    defaultValues: {
      title: '',
      description: '',
      priority: 'HIGH',
      assigned_identity: availableUsers[1]?.auth_identity || 'identity_marcus_vance',
      requires_approval: true,
    },
  });

  const onSubmit = async (values: TaskFormValues) => {
    try {
      await createTask(values);
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
      title="Create Incident Action Task"
      subtitle="Dispatches an action item to responders. Critical actions require Commander approval before start."
      maxWidth="md"
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label className="block text-xs font-mono text-slate-300 mb-1">Task Title *</label>
          <input
            {...register('title')}
            placeholder="e.g. Isolate Subnet 10.140.20.0/24 at Core Switch"
            className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500"
          />
          {errors.title && <p className="text-xs text-red-400 mt-1">{errors.title.message}</p>}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-mono text-slate-300 mb-1">Priority *</label>
            <select
              {...register('priority')}
              className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-500"
            >
              <option value="CRITICAL">CRITICAL</option>
              <option value="HIGH">HIGH</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="LOW">LOW</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-mono text-slate-300 mb-1">Assign Responder *</label>
            <select
              {...register('assigned_identity')}
              className="w-full bg-sz-bg-base border border-sz-bg-border rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-cyan-500"
            >
              {availableUsers.map((u) => (
                <option key={u.id} value={u.auth_identity}>
                  {u.display_name} ({u.role})
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-mono text-slate-300 mb-1">Action Description & Procedures *</label>
          <textarea
            {...register('description')}
            rows={3}
            placeholder="Step-by-step containment instructions, safety procedures, and verification criteria..."
            className="w-full bg-sz-bg-base border border-sz-bg-border rounded p-3 text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500"
          />
          {errors.description && <p className="text-xs text-red-400 mt-1">{errors.description.message}</p>}
        </div>

        <div className="flex items-center gap-2 p-3 rounded bg-sz-bg-base border border-sz-bg-border">
          <input
            type="checkbox"
            id="requires_approval"
            {...register('requires_approval')}
            className="w-4 h-4 rounded text-cyan-600 bg-sz-bg-surface border-sz-bg-border focus:ring-cyan-500"
          />
          <label htmlFor="requires_approval" className="text-xs text-slate-300 cursor-pointer">
            <strong>Require Commander Approval</strong> (Recommended for network isolation, account resets, or physical overrides)
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-sz-bg-border">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={isSubmitting} icon={<Plus className="w-4 h-4" />}>
            Dispatch Task
          </Button>
        </div>
      </form>
    </Modal>
  );
};

