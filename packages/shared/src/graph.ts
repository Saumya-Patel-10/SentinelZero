// Cyber-to-Human Impact Graph contract (THREE_AGENT_PLAN graph_node / graph_edge). FROZEN v1.
// Pure transform from subscribed view rows; both the 2D and 3D renderers must consume this output.

export type GraphNodeKind = 'asset' | 'service' | 'impact_group';
export type GraphEdgeKind = 'dependency' | 'impact';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  status: string;
  severity: string;
  verification: string;
  incident_id: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  verification: string;
}

export interface ImpactGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Minimal structural inputs; generated binding row types satisfy these. */
export interface AssetLike {
  id: string;
  incidentId: string;
  name: string;
  criticality: string;
  compromiseStatus: string;
  availabilityStatus: string;
}
export interface ServiceLike {
  id: string;
  incidentId: string;
  name: string;
  criticality: string;
  availabilityStatus: string;
  availabilityVerification: string;
}
export interface DependencyLike {
  id: string;
  incidentId: string;
  sourceAssetId: string;
  targetServiceId: string;
  verification: string;
}
export interface ImpactLike {
  id: string;
  incidentId: string;
  serviceId: string;
  severity: string;
  verification: string;
  affectedGroup: string;
  impactType: string;
}

/** Asset compromise -> verification vocabulary used on graph nodes. */
function assetVerification(compromise: string): string {
  switch (compromise) {
    case 'CONFIRMED':
    case 'CONTAINED':
    case 'RECOVERED':
      return 'CONFIRMED';
    case 'SUSPECTED':
      return 'SUSPECTED';
    default:
      return 'UNKNOWN';
  }
}

export const impactGroupNodeId = (incidentId: string, group: string) => `group:${incidentId}:${group.trim().toLowerCase()}`;

/**
 * Builds nodes/edges for one incident. Impact-group nodes come ONLY from explicit
 * operational_impact rows; personal harm is never inferred from a dependency alone.
 * Edges whose endpoints are missing (e.g. filtered by permissions) are dropped.
 */
export function buildImpactGraph(
  incidentId: string,
  input: { assets: AssetLike[]; services: ServiceLike[]; dependencies: DependencyLike[]; impacts: ImpactLike[] }
): ImpactGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];

  for (const a of input.assets) {
    if (a.incidentId !== incidentId) continue;
    nodes.set(a.id, {
      id: a.id,
      kind: 'asset',
      label: a.name,
      status: a.compromiseStatus,
      severity: a.criticality,
      verification: assetVerification(a.compromiseStatus),
      incident_id: incidentId,
    });
  }
  for (const s of input.services) {
    if (s.incidentId !== incidentId) continue;
    nodes.set(s.id, {
      id: s.id,
      kind: 'service',
      label: s.name,
      status: s.availabilityStatus,
      severity: s.criticality,
      verification: s.availabilityVerification,
      incident_id: incidentId,
    });
  }
  for (const d of input.dependencies) {
    if (d.incidentId !== incidentId || !nodes.has(d.sourceAssetId) || !nodes.has(d.targetServiceId)) continue;
    edges.push({ id: d.id, source: d.sourceAssetId, target: d.targetServiceId, kind: 'dependency', verification: d.verification });
  }
  for (const i of input.impacts) {
    if (i.incidentId !== incidentId || !nodes.has(i.serviceId) || i.affectedGroup.trim() === '') continue;
    const groupId = impactGroupNodeId(incidentId, i.affectedGroup);
    const existing = nodes.get(groupId);
    if (!existing) {
      nodes.set(groupId, {
        id: groupId,
        kind: 'impact_group',
        label: i.affectedGroup.trim(),
        status: i.impactType,
        severity: i.severity,
        verification: i.verification,
        incident_id: incidentId,
      });
    } else {
      existing.severity = maxSeverity(existing.severity, i.severity);
      existing.verification = strongerVerification(existing.verification, i.verification);
    }
    edges.push({ id: i.id, source: i.serviceId, target: groupId, kind: 'impact', verification: i.verification });
  }
  return { nodes: [...nodes.values()], edges };
}

const SEVERITY_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
function maxSeverity(a: string, b: string): string {
  return SEVERITY_ORDER.indexOf(b) > SEVERITY_ORDER.indexOf(a) ? b : a;
}

// RULED_OUT < UNKNOWN < SUSPECTED < CONFIRMED for aggregating a group node.
const VERIFICATION_ORDER = ['RULED_OUT', 'UNKNOWN', 'SUSPECTED', 'CONFIRMED'];
function strongerVerification(a: string, b: string): string {
  return VERIFICATION_ORDER.indexOf(b) > VERIFICATION_ORDER.indexOf(a) ? b : a;
}
