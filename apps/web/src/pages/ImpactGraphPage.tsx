import React, { useState, useEffect, lazy, Suspense } from 'react';
import { useGraphStore } from '../stores/graphStore';
import { useUIStore } from '../stores/uiStore';
import { ImpactGraph2D } from '../components/graph/ImpactGraph2D';
import { NodeDetailDrawer } from '../components/graph/NodeDetailDrawer';
import { Button } from '../components/ui/Button';
import { Box, Filter, Loader2, RefreshCw, Search } from 'lucide-react';
import { VerificationStatus } from '../services/contracts';

// Lazy-load Three.js 3D scene with fallback
const ImpactGraph3D = lazy(() =>
  import('../components/three/ImpactGraph3D').then((m) => ({ default: m.ImpactGraph3D }))
);

export const ImpactGraphPage: React.FC = () => {
  const {
    searchQuery,
    setSearchQuery,
    statusFilter,
    setStatusFilter,
    selectedNode,
    setSelectedNode,
    refreshFromSpacetime,
  } = useGraphStore();

  const is3DMode = useUIStore((s) => s.is3DMode);
  const setIs3DMode = useUIStore((s) => s.setIs3DMode);
  const prefersReducedMotion = useUIStore((s) => s.prefersReducedMotion);
  const setPrefersReducedMotion = useUIStore((s) => s.setPrefersReducedMotion);

  // Check WebGL availability and system reduced motion preference
  const [webGLAvailable, setWebGLAvailable] = useState(true);

  useEffect(() => {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      setWebGLAvailable(!!gl);
    } catch {
      setWebGLAvailable(false);
    }

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(motionQuery.matches);
  }, [setPrefersReducedMotion]);

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] bg-sz-bg-deep border border-sz-bg-border rounded-lg overflow-hidden relative">
      {/* Top Controls Toolbar */}
      <div className="p-3 border-b border-sz-bg-border bg-sz-bg-surface/90 backdrop-blur-md flex flex-wrap items-center justify-between gap-3 z-20">
        {/* Search & Status Filters */}
        <div className="flex items-center gap-2.5 flex-1 max-w-lg">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search assets, clinical services, or impacted groups..."
              className="w-full bg-sz-bg-base border border-sz-bg-border rounded pl-9 pr-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500 font-mono"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as VerificationStatus | 'ALL')}
              className="bg-sz-bg-base border border-sz-bg-border rounded px-2.5 py-1.5 text-xs text-cyan-300 font-mono focus:outline-none"
            >
              <option value="ALL">ALL STATUSES</option>
              <option value="CONFIRMED">CONFIRMED ONLY</option>
              <option value="SUSPECTED">SUSPECTED ONLY</option>
              <option value="RULED_OUT">RULED OUT</option>
              <option value="UNKNOWN">UNKNOWN</option>
            </select>
          </div>
        </div>

        {/* 2D vs 3D View Switcher & Reset */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={refreshFromSpacetime}
            title="Reset layout & sync"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
          >
            Reset
          </Button>

          {/* 2D/3D Mode Toggle with WebGL Guardrail */}
          <div className="flex items-center p-0.5 rounded bg-sz-bg-base border border-sz-bg-border text-xs font-mono">
            <button
              onClick={() => setIs3DMode(false)}
              className={`px-3 py-1 rounded transition-colors ${
                !is3DMode
                  ? 'bg-cyan-600 text-slate-900 font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              2D FLOW
            </button>
            <button
              onClick={() => {
                if (!webGLAvailable) {
                  alert('WebGL is not supported or hardware acceleration is disabled on this device. Fallback to 2D.');
                  return;
                }
                if (prefersReducedMotion) {
                  const proceed = confirm(
                    'System prefers reduced motion. 3D mode contains animations. Would you like to proceed anyway?'
                  );
                  if (!proceed) return;
                }
                setIs3DMode(true);
              }}
              className={`px-3 py-1 rounded transition-colors flex items-center gap-1 ${
                is3DMode
                  ? 'bg-cyan-600 text-slate-900 font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Box className="w-3 h-3" />
              <span>3D SCENE</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Graph Area */}
      <div className="flex-1 relative flex overflow-hidden">
        <div className="flex-1 h-full w-full">
          {is3DMode && webGLAvailable ? (
            <Suspense
              fallback={
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-cyan-400 font-mono text-sm">
                  <Loader2 className="w-6 h-6 animate-spin text-cyan-400" />
                  <span>INITIALIZING 3D GRAPH ENGINE...</span>
                </div>
              }
            >
              <ImpactGraph3D />
            </Suspense>
          ) : (
            <ImpactGraph2D />
          )}
        </div>

        {/* Node Detail Drawer */}
        {selectedNode && (
          <NodeDetailDrawer node={selectedNode} onClose={() => setSelectedNode(null)} />
        )}
      </div>

      {/* Grounding Truth Banner */}
      <div className="px-4 py-1.5 border-t border-sz-bg-border bg-sz-bg-surface flex items-center justify-between text-[11px] font-mono text-slate-400">
        <div>
          Cyber-to-Human mapping: <strong>Asset (Cyber) &rarr; Dependent Service (Ops) &rarr; Impacted Teams (Human)</strong>
        </div>
        <div className="text-amber-400">
          Suspected impacts preserved as UNVERIFIED until forensic confirmation.
        </div>
      </div>
    </div>
  );
};
