import React, { useRef, useState, useMemo, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text, Html } from '@react-three/drei';
import * as THREE from 'three';
import { useGraphStore } from '../../stores/graphStore';
import { NormalizedGraphNode } from '../../services/graphTransform';
import { StatusBadge } from '../ui/Badge';

// Shared Geometries & Materials to optimize draw calls and memory
const sphereGeom = new THREE.SphereGeometry(0.5, 24, 24);
const boxGeom = new THREE.BoxGeometry(0.9, 0.9, 0.9);
const octGeom = new THREE.OctahedronGeometry(0.7);

function Node3D({
  node,
  isSelected,
  onClick,
}: {
  node: NormalizedGraphNode;
  isSelected: boolean;
  onClick: (node: NormalizedGraphNode) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  const color = useMemo(() => {
    if (node.status === 'CONFIRMED') return '#ef4444';
    if (node.status === 'SUSPECTED') return '#f59e0b';
    if (node.status === 'RULED_OUT') return '#10b981';
    return '#06b6d4';
  }, [node.status]);

  useFrame((_, delta) => {
    if (meshRef.current && (hovered || isSelected)) {
      meshRef.current.rotation.y += delta * 1.5;
    }
  });

  const geom = node.type === 'ASSET' ? boxGeom : node.type === 'SERVICE' ? octGeom : sphereGeom;

  return (
    <group position={node.position3D}>
      <mesh
        ref={meshRef}
        geometry={geom}
        onClick={(e) => {
          e.stopPropagation();
          onClick(node);
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
        scale={isSelected ? 1.4 : hovered ? 1.2 : 1}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={isSelected ? 0.6 : hovered ? 0.4 : 0.15}
          roughness={0.2}
          metalness={0.8}
          wireframe={node.status === 'UNKNOWN'}
        />
      </mesh>

      {/* Floating 3D Label */}
      <Text
        position={[0, -0.85, 0]}
        fontSize={0.28}
        color={isSelected ? '#22d3ee' : '#cbd5e1'}
        anchorX="center"
        anchorY="top"
        maxWidth={3}
      >
        {node.label}
      </Text>

      {/* Interactive Tooltip on Hover */}
      {hovered && (
        <Html distanceFactor={15} position={[0, 1.2, 0]} center>
          <div className="p-2.5 rounded bg-sz-bg-surface/95 border border-sz-bg-border shadow-xl backdrop-blur-md text-xs font-mono w-48 pointer-events-none select-none">
            <div className="font-bold text-slate-100 truncate">{node.label}</div>
            <div className="text-[10px] text-slate-400 mb-1.5">{node.type}</div>
            <StatusBadge status={node.status} size="sm" />
          </div>
        </Html>
      )}
    </group>
  );
}

function Edges3D({
  edges,
  nodes,
}: {
  edges: ReturnType<typeof useGraphStore.getState>['edges'];
  nodes: NormalizedGraphNode[];
}) {
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n.position3D])), [nodes]);

  const lineElements = useMemo(() => {
    return edges.map((e) => {
      const p1 = nodeMap.get(e.source);
      const p2 = nodeMap.get(e.target);
      if (!p1 || !p2) return null;

      const points = [new THREE.Vector3(...p1), new THREE.Vector3(...p2)];
      const geometry = new THREE.BufferGeometry().setFromPoints(points);

      const color =
        e.status === 'CONFIRMED'
          ? '#ef4444'
          : e.status === 'SUSPECTED'
          ? '#f59e0b'
          : '#0891b2';

      return (
        <primitive
          key={e.id}
          object={new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, linewidth: 1, transparent: true, opacity: 0.6 }))}
        />
      );
    });
  }, [edges, nodeMap]);

  return <group>{lineElements}</group>;
}

export const ImpactGraph3D: React.FC = () => {
  const { nodes, edges, selectedNode, setSelectedNode, searchQuery, statusFilter } = useGraphStore();

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

  return (
    <div className="w-full h-full bg-[#06090e] relative select-none">
      <Canvas
        camera={{ position: [0, 0, 24], fov: 45 }}
        dpr={[1, 1.5]} // Performance guardrail: capped DPR
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
      >
        <color attach="background" args={['#06090e']} />
        <ambientLight intensity={0.6} />
        <pointLight position={[15, 20, 15]} intensity={1.2} />
        <pointLight position={[-15, -20, -15]} intensity={0.8} color="#06b6d4" />

        <Suspense fallback={null}>
          <group position={[-1, 0, 0]}>
            {filteredNodes.map((node) => (
              <Node3D
                key={node.id}
                node={node}
                isSelected={selectedNode?.id === node.id}
                onClick={setSelectedNode}
              />
            ))}
            <Edges3D edges={edges} nodes={filteredNodes} />
          </group>
        </Suspense>

        <OrbitControls
          enableDamping
          dampingFactor={0.05}
          maxDistance={45}
          minDistance={6}
          maxPolarAngle={Math.PI / 1.7}
        />
      </Canvas>

      {/* 3D Scene Helper Overlay */}
      <div className="absolute bottom-4 left-4 p-2.5 rounded bg-sz-bg-surface/80 backdrop-blur-md border border-sz-bg-border text-[11px] font-mono text-slate-400 space-y-1 pointer-events-none">
        <div><strong>Left Drag:</strong> Rotate Orbit</div>
        <div><strong>Right Drag:</strong> Pan Camera</div>
        <div><strong>Scroll:</strong> Zoom</div>
        <div><strong>Click Node:</strong> Inspect Evidence</div>
      </div>
    </div>
  );
};
