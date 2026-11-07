import React from 'react';
import { TaskBoard } from '../components/tasks/TaskBoard';

export const TasksPage: React.FC = () => {
  return (
    <div className="bg-sz-bg-surface border border-sz-bg-border rounded-lg p-5 animate-fade-in">
      <TaskBoard />
    </div>
  );
};
