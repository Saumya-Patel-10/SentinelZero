import { useState, useEffect, useCallback } from 'react';
import { spacetimeClient } from '../services/spacetimeClient';
import { Task, TaskPriority, TaskStatus } from '../services/contracts';

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(spacetimeClient.getState().tasks);

  useEffect(() => {
    return spacetimeClient.subscribe((state) => {
      setTasks(state.tasks);
    });
  }, []);

  const approveTask = useCallback(async (taskId: string) => {
    return await spacetimeClient.approveTask(taskId);
  }, []);

  const rejectTask = useCallback(async (taskId: string, reason?: string) => {
    return await spacetimeClient.rejectTask(taskId, reason);
  }, []);

  const updateTaskStatus = useCallback(async (taskId: string, status: TaskStatus) => {
    return await spacetimeClient.updateTaskStatus(taskId, status);
  }, []);

  const createTask = useCallback(
    async (payload: {
      title: string;
      description: string;
      priority: TaskPriority;
      assigned_identity: string;
      requires_approval?: boolean;
    }) => {
      return await spacetimeClient.createTask(payload);
    },
    []
  );

  const awaitingApproval = tasks.filter((t) => t.approval_status === 'PENDING_APPROVAL');
  const inProgress = tasks.filter((t) => t.status === 'IN_PROGRESS');
  const completed = tasks.filter((t) => t.status === 'COMPLETED');
  const pending = tasks.filter((t) => t.status === 'PENDING');

  return {
    tasks,
    awaitingApproval,
    inProgress,
    completed,
    pending,
    approveTask,
    rejectTask,
    updateTaskStatus,
    createTask,
  };
}
