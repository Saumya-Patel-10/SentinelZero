/**
 * UI State Store (Zustand)
 * Handles navigation, modals, active selection, accessibility flags, and role emulation.
 */

import { create } from 'zustand';
import { Role } from '../services/contracts';

export type ActiveView = 
  | 'COMMAND_CENTER'
  | 'IMPACT_GRAPH'
  | 'TASKS_BOARD'
  | 'COMMUNICATIONS'
  | 'AUDIT_TIMELINE'
  | 'AI_ASSISTANT';

interface UIState {
  currentView: ActiveView;
  setCurrentView: (view: ActiveView) => void;

  // Graph view modes
  is3DMode: boolean;
  setIs3DMode: (enabled: boolean) => void;
  supportsWebGL: boolean;
  setSupportsWebGL: (supported: boolean) => void;
  prefersReducedMotion: boolean;
  setPrefersReducedMotion: (reduced: boolean) => void;

  // Drawers and Modals
  isCreateIncidentOpen: boolean;
  setCreateIncidentOpen: (open: boolean) => void;
  isCreateTaskOpen: boolean;
  setCreateTaskOpen: (open: boolean) => void;
  isAIPanelOpen: boolean;
  setAIPanelOpen: (open: boolean) => void;

  // Selected entities for inspect sidebars
  selectedNodeId: string | null;
  setSelectedNodeId: (id: string | null) => void;
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;

  // Active Role emulation for testing & authorization verification
  activeRole: Role;
  setActiveRole: (role: Role) => void;

  // Notifications
  bannerNotice: string | null;
  setBannerNotice: (msg: string | null) => void;
}

export const useUIStore = create<UIState>((set) => ({
  currentView: 'COMMAND_CENTER',
  setCurrentView: (view) => set({ currentView: view }),

  is3DMode: false,
  setIs3DMode: (enabled) => set({ is3DMode: enabled }),
  supportsWebGL: true,
  setSupportsWebGL: (supported) => set({ supportsWebGL: supported }),
  prefersReducedMotion: false,
  setPrefersReducedMotion: (reduced) => set({ prefersReducedMotion: reduced }),

  isCreateIncidentOpen: false,
  setCreateIncidentOpen: (open) => set({ isCreateIncidentOpen: open }),
  isCreateTaskOpen: false,
  setCreateTaskOpen: (open) => set({ isCreateTaskOpen: open }),
  isAIPanelOpen: false,
  setAIPanelOpen: (open) => set({ isAIPanelOpen: open }),

  selectedNodeId: null,
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
  selectedTaskId: null,
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),

  activeRole: 'COMMANDER',
  setActiveRole: (role) => set({ activeRole: role }),

  bannerNotice: null,
  setBannerNotice: (msg) => set({ bannerNotice: msg }),
}));
