/**
 * Canonical Graph Transform for SentinelZero Cyber-to-Human Impact Graph
 * Strictly preserves uncertainty: UNKNOWN, SUSPECTED, CONFIRMED, RULED_OUT.
 * Does not invent relationships or treat suspected as confirmed.
 * Supplies identical normalized data to both React Flow 2D and Three.js 3D.
 */

import { Asset, ServiceDependency, OperationalImpact, VerificationStatus } from './contracts';

export type GraphNodeType = 'ASSET' | 'SERVICE' | 'AFFECTED_GROUP';

export interface NormalizedGraphNode {
  id: string;
  label: string;
  sublabel?: string;
  type: GraphNodeType;
  category?: string;
  status: VerificationStatus;
  availabilityStatus?: VerificationStatus;
  criticality?: string;
  details: Record<string, unknown>;
  // Layering for 2D/3D layout: Layer 0 = Cyber Assets, Layer 1 = Operational Services, Layer 2 = Human Affected Groups
  layer: number;
  position2D: { x: number; y: number };
  position3D: [number, number, number];
}

export interface NormalizedGraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'DEPENDENCY' | 'HUMAN_IMPACT';
  label?: string;
  confidence?: number;
  isConfirmed: boolean;
  status: VerificationStatus;
}

export interface TransformedGraph {
  nodes: NormalizedGraphNode[];
  edges: NormalizedGraphEdge[];
  summary: {
    totalAssets: number;
    compromisedConfirmed: number;
    compromisedSuspected: number;
    servicesDisrupted: number;
    humanGroupsAffected: number;
  };
}

export function transformToImpactGraph(
  assets: Asset[],
  dependencies: ServiceDependency[],
  impacts: OperationalImpact[]
): TransformedGraph {
  const nodes: NormalizedGraphNode[] = [];
  const edges: NormalizedGraphEdge[] = [];

  // 1. ASSET NODES (Layer 0)
  const assetSpacingX = 240;
  const assetCols = 3;
  assets.forEach((asset, idx) => {
    const col = idx % assetCols;
    const row = Math.floor(idx / assetCols);
    
    // 2D position (Left side of flow)
    const x2D = col * assetSpacingX;
    const y2D = row * 160;

    // 3D position (Left plane in 3D space: x = -12 to -4)
    const x3D = -10 + col * 3;
    const y3D = 6 - row * 2.8;
    const z3D = (col % 2 === 0 ? 0 : -1.5);

    nodes.push({
      id: asset.id,
      label: asset.name,
      sublabel: asset.type.replace('_', ' ') + (asset.ip_address ? ` • ${asset.ip_address}` : ''),
      type: 'ASSET',
      category: asset.type,
      status: asset.compromise_status,
      availabilityStatus: asset.availability_status,
      criticality: asset.criticality,
      details: {
        ...asset,
      },
      layer: 0,
      position2D: { x: x2D, y: y2D },
      position3D: [x3D, y3D, z3D],
    });
  });

  // 2. OPERATIONAL SERVICE NODES (Layer 1)
  const serviceSpacingY = 220;
  const serviceOffsetX = 850;
  const serviceMap = new Map<string, OperationalImpact>();

  impacts.forEach((impact, idx) => {
    serviceMap.set(impact.service_id, impact);

    const x2D = serviceOffsetX;
    const y2D = idx * serviceSpacingY + 60;

    // 3D position (Center column in 3D: x = 2)
    const x3D = 2;
    const y3D = 4 - idx * 3.5;
    const z3D = 0;

    nodes.push({
      id: impact.service_id,
      label: impact.service_name,
      sublabel: `Impact: ${impact.impact_type} (${impact.severity})`,
      type: 'SERVICE',
      status: impact.verification_status,
      criticality: impact.severity,
      details: {
        ...impact,
      },
      layer: 1,
      position2D: { x: x2D, y: y2D },
      position3D: [x3D, y3D, z3D],
    });
  });

  // 3. HUMAN AFFECTED GROUPS (Layer 2)
  const groupOffsetX = 1350;
  const humanGroupSet = new Set<string>();
  const groupToServiceLinks: { groupName: string; serviceId: string; status: VerificationStatus }[] = [];

  impacts.forEach(impact => {
    impact.affected_groups.forEach(groupName => {
      humanGroupSet.add(groupName);
      groupToServiceLinks.push({
        groupName,
        serviceId: impact.service_id,
        status: impact.verification_status,
      });
    });
  });

  const uniqueGroups = Array.from(humanGroupSet);
  uniqueGroups.forEach((groupName, idx) => {
    const groupId = `grp_${groupName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    const x2D = groupOffsetX;
    const y2D = idx * 130 + 40;

    // 3D position (Right plane: x = 12)
    const x3D = 12;
    const y3D = 5 - idx * 2.2;
    const z3D = (idx % 2 === 0 ? 0 : 1);

    // Group verification status is derived from connected services without inflating certainty
    const connectedStatuses = groupToServiceLinks
      .filter(l => l.groupName === groupName)
      .map(l => l.status);
    
    const worstStatus: VerificationStatus = connectedStatuses.includes('CONFIRMED')
      ? 'CONFIRMED'
      : connectedStatuses.includes('SUSPECTED')
      ? 'SUSPECTED'
      : 'UNKNOWN';

    nodes.push({
      id: groupId,
      label: groupName,
      sublabel: 'Operational Group Impacted',
      type: 'AFFECTED_GROUP',
      status: worstStatus,
      details: {
        groupName,
        connectedServices: groupToServiceLinks.filter(l => l.groupName === groupName).map(l => l.serviceId),
      },
      layer: 2,
      position2D: { x: x2D, y: y2D },
      position3D: [x3D, y3D, z3D],
    });
  });

  // 4. EDGES: ASSET -> SERVICE (Verified dependencies)
  dependencies.forEach(dep => {
    // Only connect if both source asset and target service exist
    const sourceExists = assets.some(a => a.id === dep.source_asset_id);
    const targetExists = impacts.some(s => s.service_id === dep.target_service_id);

    if (sourceExists && targetExists) {
      edges.push({
        id: `edge_${dep.source_asset_id}_${dep.target_service_id}`,
        source: dep.source_asset_id,
        target: dep.target_service_id,
        type: 'DEPENDENCY',
        label: `${dep.type} (${Math.round(dep.confidence * 100)}%)`,
        confidence: dep.confidence,
        isConfirmed: dep.confidence >= 0.9,
        status: dep.confidence >= 0.9 ? 'CONFIRMED' : 'SUSPECTED',
      });
    }
  });

  // 5. EDGES: SERVICE -> HUMAN GROUP
  groupToServiceLinks.forEach(link => {
    const groupId = `grp_${link.groupName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    edges.push({
      id: `edge_${link.serviceId}_${groupId}`,
      source: link.serviceId,
      target: groupId,
      type: 'HUMAN_IMPACT',
      label: 'Directly Impacted',
      isConfirmed: link.status === 'CONFIRMED',
      status: link.status,
    });
  });

  // Calculate Metrics
  const confirmedCompromise = assets.filter(a => a.compromise_status === 'CONFIRMED').length;
  const suspectedCompromise = assets.filter(a => a.compromise_status === 'SUSPECTED').length;

  return {
    nodes,
    edges,
    summary: {
      totalAssets: assets.length,
      compromisedConfirmed: confirmedCompromise,
      compromisedSuspected: suspectedCompromise,
      servicesDisrupted: impacts.length,
      humanGroupsAffected: uniqueGroups.length,
    },
  };
}
