import { describe, it, expect } from 'vitest';
import { transformToImpactGraph } from '../services/graphTransform';
import { MOCK_ASSETS, MOCK_DEPENDENCIES, MOCK_OPERATIONAL_IMPACTS } from '../fixtures/mockData';

describe('Cyber-to-Human Impact Graph Canonical Transform', () => {
  it('correctly builds normalized 2D/3D graph layers from canonical contracts', () => {
    const graph = transformToImpactGraph(MOCK_ASSETS, MOCK_DEPENDENCIES, MOCK_OPERATIONAL_IMPACTS);

    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);

    // Verify layers
    const assetNodes = graph.nodes.filter((n) => n.layer === 0);
    const serviceNodes = graph.nodes.filter((n) => n.layer === 1);
    const groupNodes = graph.nodes.filter((n) => n.layer === 2);

    expect(assetNodes.length).toBe(MOCK_ASSETS.length);
    expect(serviceNodes.length).toBe(MOCK_OPERATIONAL_IMPACTS.length);
    expect(groupNodes.length).toBeGreaterThan(0);

    // Verify 2D and 3D coordinates exist on every node
    graph.nodes.forEach((node) => {
      expect(node.position2D).toBeDefined();
      expect(typeof node.position2D.x).toBe('number');
      expect(typeof node.position2D.y).toBe('number');

      expect(node.position3D).toBeDefined();
      expect(node.position3D.length).toBe(3);
    });
  });

  it('preserves uncertainty and does not treat suspected or unknown as confirmed', () => {
    const graph = transformToImpactGraph(MOCK_ASSETS, MOCK_DEPENDENCIES, MOCK_OPERATIONAL_IMPACTS);

    const suspectedAsset = graph.nodes.find((n) => n.id === 'ast_ehr_db_01');
    expect(suspectedAsset).toBeDefined();
    expect(suspectedAsset?.status).toBe('SUSPECTED');

    const confirmedAsset = graph.nodes.find((n) => n.id === 'ast_pacs_01');
    expect(confirmedAsset).toBeDefined();
    expect(confirmedAsset?.status).toBe('CONFIRMED');

    const unknownAsset = graph.nodes.find((n) => n.id === 'ast_dc_02');
    expect(unknownAsset).toBeDefined();
    expect(unknownAsset?.status).toBe('UNKNOWN');
  });

  it('does not invent relationships between disconnected nodes', () => {
    const graph = transformToImpactGraph(MOCK_ASSETS, MOCK_DEPENDENCIES, MOCK_OPERATIONAL_IMPACTS);

    // Core firewall is RULED_OUT and not connected to any disrupted clinical service in mock
    const fwEdges = graph.edges.filter((e) => e.source === 'ast_fw_core_01');
    expect(fwEdges.length).toBe(0);
  });
});

