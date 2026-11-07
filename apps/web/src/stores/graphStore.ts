/**
 * Graph State Store (Zustand)
 * Maintains transformed 2D/3D normalized graph state, search, and filters.
 */

import { create } from 'zustand';
import { NormalizedGraphNode, NormalizedGraphEdge, TransformedGraph, transformToImpactGraph } from '../services/graphTransform';
import { spacetimeClient } from '../services/spacetimeClient';
import { VerificationStatus } from '../services/contracts';

interface GraphState {
  nodes: NormalizedGraphNode[];
  edges: NormalizedGraphEdge[];
  summary: TransformedGraph['summary'];
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  statusFilter: VerificationStatus | 'ALL';
  setStatusFilter: (status: VerificationStatus | 'ALL') => void;
  selectedNode: NormalizedGraphNode | null;
  setSelectedNode: (node: NormalizedGraphNode | null) => void;
  refreshFromSpacetime: () => void;
}

export const useGraphStore = create<GraphState>((set, get) => {
  // Initial compute
  const initial = spacetimeClient.getState();
  const transformed = transformToImpactGraph(initial.assets, initial.dependencies, initial.impacts);

  // Subscribe to real-time spacetime changes
  spacetimeClient.subscribe((state) => {
    const updated = transformToImpactGraph(state.assets, state.dependencies, state.impacts);
    set({
      nodes: updated.nodes,
      edges: updated.edges,
      summary: updated.summary,
    });
  });

  return {
    nodes: transformed.nodes,
    edges: transformed.edges,
    summary: transformed.summary,
    searchQuery: '',
    setSearchQuery: (searchQuery) => set({ searchQuery }),
    statusFilter: 'ALL',
    setStatusFilter: (statusFilter) => set({ statusFilter }),
    selectedNode: null,
    setSelectedNode: (selectedNode) => set({ selectedNode }),
    refreshFromSpacetime: () => {
      const state = spacetimeClient.getState();
      const updated = transformToImpactGraph(state.assets, state.dependencies, state.impacts);
      set({
        nodes: updated.nodes,
        edges: updated.edges,
        summary: updated.summary,
      });
    },
  };
});

