import React, { useMemo } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  Node,
  Edge,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useGraphStore } from '../../stores/graphStore';
import { AssetNode, ServiceNode, GroupNode } from './CustomNodes';
import { NormalizedGraphNode } from '../../services/graphTransform';

const nodeTypes = {
  ASSET: AssetNode,
  SERVICE: ServiceNode,
  AFFECTED_GROUP: GroupNode,
};

export const ImpactGraph2D: React.FC = () => {
  const { nodes, edges, searchQuery, statusFilter, selectedNode, setSelectedNode } = useGraphStore();

  // Filter nodes based on search and status filter
  const filteredNodes = useMemo(() => {
    return nodes.filter((n) => {
      const matchesSearch =
        searchQuery === '' ||
        n.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (n.sublabel && n.sublabel.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesStatus = statusFilter === 'ALL' || n.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [nodes, searchQuery, statusFilter]);

  const activeNodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);

  // Convert to React Flow Nodes
  const rfNodes: Node[] = useMemo(() => {
    return filteredNodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position2D,
      data: { ...n },
      selected: selectedNode?.id === n.id,
    }));
  }, [filteredNodes, selectedNode]);

  // Convert to React Flow Edges
  const rfEdges: Edge[] = useMemo(() => {
    return edges
      .filter((e) => activeNodeIds.has(e.source) && activeNodeIds.has(e.target))
      .map((e) => {
        const isSelected = selectedNode && (selectedNode.id === e.source || selectedNode.id === e.target);
        const strokeColor =
          e.status === 'CONFIRMED'
            ? '#ef4444'
            : e.status === 'SUSPECTED'
            ? '#f59e0b'
            : '#38bdf8';

        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.label,
          type: 'smoothstep',
          animated: isSelected || e.status === 'CONFIRMED',
          style: {
            stroke: strokeColor,
            strokeWidth: isSelected ? 3 : 1.5,
            opacity: selectedNode ? (isSelected ? 1 : 0.2) : 0.8,
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: strokeColor,
            width: 15,
            height: 15,
          },
        };
      });
  }, [edges, activeNodeIds, selectedNode]);

  const onNodeClick = (_: React.MouseEvent, node: Node) => {
    const raw = nodes.find((n) => n.id === node.id) || null;
    setSelectedNode(raw);
  };

  const onPaneClick = () => {
    setSelectedNode(null);
  };

  return (
    <div className="w-full h-full bg-[#06090e] relative select-none">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        aria-label="Interactive 2D Cyber-to-Human Impact Graph"
      >
        <Background color="#1e293b" gap={24} size={1} />
        <Controls className="bg-sz-bg-surface border border-sz-bg-border rounded text-slate-300 fill-slate-300" />
        <MiniMap
          nodeColor={(n) => {
            if (n.data?.status === 'CONFIRMED') return '#ef4444';
            if (n.data?.status === 'SUSPECTED') return '#f59e0b';
            return '#06b6d4';
          }}
          className="bg-sz-bg-deep border border-sz-bg-border rounded overflow-hidden"
          maskColor="rgba(11, 15, 23, 0.7)"
        />
      </ReactFlow>
    </div>
  );
};

