import { z } from 'zod';
import {
  AGENT_RUN_STATUSES,
  ANALYSIS_TYPES,
  INFERENCE_MODES,
  TASK_PRIORITIES,
  VERIFICATION,
} from './enums';

// Browser <-> FastAPI contract (FROZEN v1). Field names are snake_case on the wire.
//
// CHANGE vs THREE_AGENT_PLAN draft: ai_analyze_request now REQUIRES `run_id`. The browser first
// calls the SpacetimeDB reducer `request_agent_run` (so the requester is the DB-verified
// ctx.sender), reads the run id from the `my_agent_runs` view, then calls FastAPI.

export const Id = z.string().min(1).max(64);

export const AiAnalyzeRequest = z
  .object({
    incident_id: Id,
    run_id: Id,
    analysis_type: z.enum(ANALYSIS_TYPES),
  })
  .strict();
export type AiAnalyzeRequest = z.infer<typeof AiAnalyzeRequest>;

/** Lower-case mirror of AGENT_RUN_STATUSES for the HTTP API; EXPIRED maps to "failed". */
export const AI_RUN_HTTP_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const;
export const AiRunHttpStatus = z.enum(AI_RUN_HTTP_STATUSES);

export const VerifiedFact = z
  .object({
    statement: z.string().min(1).max(1000),
    /** IDs from evidence_reference; must be non-empty for a "verified" fact. */
    evidence_ids: z.array(Id).min(1).max(20),
    verification: z.enum(VERIFICATION),
  })
  .strict();

export const ProposedAction = z
  .object({
    title: z.string().min(3).max(200),
    description: z.string().max(5000),
    priority: z.enum(TASK_PRIORITIES),
    rationale: z.string().min(10).max(4000),
    evidence_ids: z.array(Id).max(20),
    uncertainties: z.array(z.string().min(1).max(500)).max(20),
    /** Set once persisted via agent_submit_recommendation. Always PENDING until a human decides. */
    recommendation_id: Id.optional(),
  })
  .strict()
  .refine(a => a.evidence_ids.length > 0 || a.uncertainties.length > 0, {
    message: 'must cite evidence or state uncertainties',
  });

export const AiAnalyzeResponse = z
  .object({
    run_id: Id,
    status: AiRunHttpStatus,
    /** LIVE only for genuine model inference. UI must label SIMULATED/FIXTURE prominently. */
    inference_mode: z.enum(INFERENCE_MODES),
    model_identifier: z.string().max(200),
    verified_facts: z.array(VerifiedFact).max(50),
    uncertainties: z.array(z.string().min(1).max(500)).max(50),
    /** Never executed automatically. */
    proposed_actions: z.array(ProposedAction).max(10),
    error_category: z.string().optional(),
  })
  .strict();
export type AiAnalyzeResponse = z.infer<typeof AiAnalyzeResponse>;

export function toHttpRunStatus(status: (typeof AGENT_RUN_STATUSES)[number]): z.infer<typeof AiRunHttpStatus> {
  switch (status) {
    case 'REQUESTED':
      return 'pending';
    case 'RUNNING':
      return 'running';
    case 'COMPLETED':
      return 'completed';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return 'failed';
  }
}

export const GraphNodeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['asset', 'service', 'impact_group']),
    label: z.string(),
    status: z.string(),
    severity: z.string(),
    verification: z.string(),
    incident_id: z.string(),
  })
  .strict();

export const GraphEdgeSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    kind: z.enum(['dependency', 'impact']),
    verification: z.string(),
  })
  .strict();
