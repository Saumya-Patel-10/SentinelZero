/**
 * SentinelZero AI Service Client (FastAPI / NVIDIA Nemotron integration)
 * Interfaces with Agent 3 API contracts.
 * Strictly preserves human approval requirement: AI recommendations remain PENDING until Commander approval.
 * Truthful telemetry: explicitly distinguishes live model inference from synthetic exercise demonstration.
 */

import { AgentRun, AgentToolCall, AgentRecommendation } from './contracts';
import { MOCK_RECOMMENDATIONS } from '../fixtures/mockData';

export interface AIAnalysisRequest {
  incident_id: string;
  scope: 'ALL' | 'CONTAINMENT_ONLY' | 'CONTINUITY_ONLY';
  model?: string;
}

export interface AIAnalysisResponse {
  run: AgentRun;
  tool_calls: AgentToolCall[];
  recommendations: AgentRecommendation[];
  is_live_nemotron: boolean;
  latency_ms: number;
}

class AIServiceClient {
  private baseUrl: string;

  constructor() {
    this.baseUrl = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8000';
  }

  /**
   * Health check on FastAPI AI agent
   */
  public async getHealth(): Promise<{ status: string; nemotron_connected: boolean; model: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { method: 'GET' });
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // Endpoint not reachable
    }
    return {
      status: 'DEMO_STANDALONE',
      nemotron_connected: false,
      model: 'synthetic-exercise-evaluator',
    };
  }

  /**
   * Trigger incident analysis with NVIDIA Nemotron
   */
  public async triggerAnalysis(req: AIAnalysisRequest): Promise<AIAnalysisResponse> {
    const startTime = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/v1/incidents/${req.incident_id}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: req.scope,
          model: req.model || 'nvidia/nemotron-4-340b-instruct',
        }),
      });

      if (res.ok) {
        const data = await res.json();
        return {
          run: data.run,
          tool_calls: data.tool_calls || [],
          recommendations: data.recommendations || [],
          is_live_nemotron: true,
          latency_ms: Date.now() - startTime,
        };
      }
    } catch {
      // Fallback to high-fidelity exercise simulation
    }

    // High-fidelity synthetic exercise response (truthfully marked is_live_nemotron: false)
    await new Promise((resolve) => setTimeout(resolve, 800)); // Simulate async model inference

    const simulatedRun: AgentRun = {
      id: `run_nemotron_${Date.now()}`,
      organization_id: 'org_hope_valley_01',
      incident_id: req.incident_id,
      requested_by: 'current_user',
      model_identifier: 'nvidia/nemotron-4-340b-instruct (EXERCISE SIMULATION)',
      status: 'COMPLETED',
      started_at: new Date(startTime).toISOString(),
      finished_at: new Date().toISOString(),
      summary: 'Nemotron evaluated 12 assets and 3 impacted services. Preserved uncertainty on data exfiltration; proposed urgent krbtgt rotation and manual pharmacy dispensing protocol.',
    };

    const simulatedToolCalls: AgentToolCall[] = [
      {
        id: 'tc_01',
        agent_run_id: simulatedRun.id,
        tool_name: 'get_incident',
        input_summary: JSON.stringify({ incident_id: req.incident_id }),
        output_summary: 'LockBit ransomware incident with critical severity on EHR & Imaging',
        status: 'EXECUTED',
        timestamp: new Date(startTime + 200).toISOString(),
      },
      {
        id: 'tc_02',
        agent_run_id: simulatedRun.id,
        tool_name: 'get_assets',
        input_summary: JSON.stringify({ filter_status: ['SUSPECTED', 'CONFIRMED'] }),
        output_summary: 'Returned 4 compromised/impacted assets: EHR-PROD-SQL-01, PACS-IMAGE-ARCHIVE, DC-01, SCHED-BILL-API',
        status: 'EXECUTED',
        timestamp: new Date(startTime + 450).toISOString(),
      },
      {
        id: 'tc_03',
        agent_run_id: simulatedRun.id,
        tool_name: 'propose_task',
        input_summary: 'krbtgt ticket invalidation & pharmacy downtime reconciliation',
        output_summary: 'Recorded 2 PENDING proposals awaiting Commander authorization',
        status: 'EXECUTED',
        timestamp: new Date(startTime + 700).toISOString(),
      },
    ];

    return {
      run: simulatedRun,
      tool_calls: simulatedToolCalls,
      recommendations: [...MOCK_RECOMMENDATIONS],
      is_live_nemotron: false, // TRUTHFUL: never claim synthetic run is live model inference
      latency_ms: Date.now() - startTime,
    };
  }
}

export const aiClient = new AIServiceClient();

