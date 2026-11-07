import { describe, expect, it } from 'vitest';
import { INCIDENT_STATUSES, ROLES, TASK_STATUSES, type IncidentStatus } from '../../../shared/src/enums';
import { classifyIncidentTransition, INCIDENT_TRANSITIONS } from '../../../shared/src/incidentLifecycle';
import { decideApproval, isValidTaskTransition, TASK_STATUS_TRANSITIONS } from '../../../shared/src/taskLifecycle';
import { CAPABILITIES, roleHas } from '../../../shared/src/permissions';
import { buildImpactGraph, impactGroupNodeId } from '../../../shared/src/graph';
import { parseBackendError } from '../../../shared/src/errors';
import { AGENT_PROCEDURE_FIELDS, decodePositional, decodeResult } from '../../../shared/src/agentContracts';
import { AiAnalyzeRequest, AiAnalyzeResponse, toHttpRunStatus } from '../../../shared/src/schemas';
import { AUDIT_GENESIS_HASH, computeAuditHash } from '../../src/security/auditHash';

describe('incident lifecycle', () => {
  it('only moves forward along the documented graph', () => {
    expect(classifyIncidentTransition('REPORTED', 'TRIAGING')).toBe('FORWARD');
    expect(classifyIncidentTransition('REPORTED', 'RESOLVED')).toBe('INVALID');
    expect(classifyIncidentTransition('CONTAINED', 'CONTAINING')).toBe('FORWARD');
    expect(classifyIncidentTransition('CLOSED', 'REPORTED')).toBe('INVALID');
  });
  it('treats RESOLVED/CLOSED -> INVESTIGATING as reopen', () => {
    expect(classifyIncidentTransition('RESOLVED', 'INVESTIGATING')).toBe('REOPEN');
    expect(classifyIncidentTransition('CLOSED', 'INVESTIGATING')).toBe('REOPEN');
  });
  it('never allows self-transitions and covers every status', () => {
    for (const s of INCIDENT_STATUSES) {
      expect(INCIDENT_TRANSITIONS[s]).toBeDefined();
      expect(classifyIncidentTransition(s, s as IncidentStatus)).toBe('INVALID');
    }
  });
});

describe('task lifecycle and approval', () => {
  it('keeps AWAITING_APPROVAL, COMPLETED and CANCELLED closed to update_task_status', () => {
    for (const to of TASK_STATUSES) {
      expect(isValidTaskTransition('AWAITING_APPROVAL', to)).toBe(false);
      expect(isValidTaskTransition('COMPLETED', to)).toBe(false);
      expect(isValidTaskTransition('CANCELLED', to)).toBe(false);
    }
    expect(Object.keys(TASK_STATUS_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
  });
  it('makes repeated decisions idempotent and contradictory ones conflicts', () => {
    expect(decideApproval('PENDING', 'APPROVE')).toEqual({ kind: 'APPLY', status: 'PENDING', approval: 'APPROVED' });
    expect(decideApproval('APPROVED', 'APPROVE')).toEqual({ kind: 'NOOP' });
    expect(decideApproval('REJECTED', 'REJECT')).toEqual({ kind: 'NOOP' });
    expect(decideApproval('APPROVED', 'REJECT').kind).toBe('CONFLICT');
    expect(decideApproval('REJECTED', 'APPROVE').kind).toBe('CONFLICT');
    expect(decideApproval('NOT_REQUIRED', 'APPROVE').kind).toBe('CONFLICT');
    expect(decideApproval('PENDING', 'REJECT')).toEqual({ kind: 'APPLY', status: 'CANCELLED', approval: 'REJECTED' });
  });
});

describe('role matrix', () => {
  it('matches the frozen v1 matrix', () => {
    const matrix = Object.fromEntries(ROLES.map(r => [r, Object.keys(CAPABILITIES).filter(c => roleHas(r, c as keyof typeof CAPABILITIES)).sort()]));
    expect(matrix).toMatchSnapshot();
  });
  it('gives OBSERVER read-only summary access', () => {
    const caps = Object.keys(CAPABILITIES).filter(c => roleHas('OBSERVER', c as keyof typeof CAPABILITIES));
    expect(caps).toEqual(['VIEW_INCIDENT_SUMMARY']);
  });
  it('restricts approvals to OWNER/COMMANDER', () => {
    expect([...CAPABILITIES.APPROVE_TASK]).toEqual(['OWNER', 'COMMANDER']);
    expect([...CAPABILITIES.DECIDE_RECOMMENDATION]).toEqual(['OWNER', 'COMMANDER']);
    expect([...CAPABILITIES.REOPEN_INCIDENT]).toEqual(['COMMANDER']);
  });
});

describe('impact graph transform', () => {
  const inc = 'inc-1';
  const assets = [{ id: 'a1', incidentId: inc, name: 'db01', criticality: 'CRITICAL', compromiseStatus: 'SUSPECTED', availabilityStatus: 'UNAVAILABLE' }];
  const services = [
    { id: 's1', incidentId: inc, name: 'Scheduling', criticality: 'HIGH', availabilityStatus: 'UNAVAILABLE', availabilityVerification: 'CONFIRMED' },
    { id: 's2', incidentId: inc, name: 'Billing', criticality: 'MEDIUM', availabilityStatus: 'AVAILABLE', availabilityVerification: 'UNKNOWN' },
  ];
  const dependencies = [
    { id: 'd1', incidentId: inc, sourceAssetId: 'a1', targetServiceId: 's1', verification: 'CONFIRMED' },
    { id: 'd2', incidentId: inc, sourceAssetId: 'a1', targetServiceId: 'missing', verification: 'UNKNOWN' },
  ];
  const impacts = [
    { id: 'i1', incidentId: inc, serviceId: 's1', severity: 'HIGH', verification: 'SUSPECTED', affectedGroup: 'Outpatients', impactType: 'SERVICE_OUTAGE' },
    { id: 'i2', incidentId: inc, serviceId: 's2', severity: 'CRITICAL', verification: 'CONFIRMED', affectedGroup: ' outpatients ', impactType: 'SERVICE_DEGRADATION' },
  ];

  it('builds nodes and edges, drops dangling edges, and merges impact groups', () => {
    const g = buildImpactGraph(inc, { assets, services, dependencies, impacts });
    expect(g.nodes.map(n => n.id).sort()).toEqual(['a1', impactGroupNodeId(inc, 'Outpatients'), 's1', 's2'].sort());
    expect(g.edges.map(e => e.id).sort()).toEqual(['d1', 'i1', 'i2']);
    const group = g.nodes.find(n => n.kind === 'impact_group')!;
    expect(group.severity).toBe('CRITICAL');
    expect(group.verification).toBe('CONFIRMED');
    expect(g.nodes.find(n => n.id === 'a1')!.verification).toBe('SUSPECTED');
  });

  it('never infers affected groups from dependencies alone', () => {
    const g = buildImpactGraph(inc, { assets, services, dependencies, impacts: [] });
    expect(g.nodes.some(n => n.kind === 'impact_group')).toBe(false);
  });

  it('ignores rows from other incidents', () => {
    const g = buildImpactGraph('other', { assets, services, dependencies, impacts });
    expect(g).toEqual({ nodes: [], edges: [] });
  });
});

describe('wire contracts', () => {
  it('parses typed backend errors, including host-prefixed messages', () => {
    expect(parseBackendError('ACCESS_DENIED: nope')).toEqual({ code: 'ACCESS_DENIED', detail: 'nope' });
    expect(parseBackendError('The module instance encountered a fatal error: VERSION_CONFLICT: v2').code).toBe('VERSION_CONFLICT');
    expect(parseBackendError('something else').code).toBe('UNKNOWN');
    expect(parseBackendError('NOT_A_CODE: x').code).toBe('UNKNOWN');
  });

  it('decodes positional procedure results and result envelopes', () => {
    const asset = ['a1', 'db01', 'DATABASE', 'HIGH', 'SUSPECTED', 'UNAVAILABLE', '', [['ds1', 'PHI', 'REGULATED', 'CONFIRMED', 'UNKNOWN', 'SUSPECTED', '42', 'MEDIUM', '']]];
    const decoded = decodePositional('AgentAsset', asset);
    expect(decoded).toMatchObject({ id: 'a1', compromiseStatus: 'SUSPECTED' });
    expect((decoded.dataScopes as Record<string, unknown>[])[0]).toMatchObject({ lockStatus: 'CONFIRMED', exfiltrationStatus: 'UNKNOWN' });
    expect(() => decodePositional('AgentAsset', ['too', 'short'])).toThrow();
    expect(decodeResult([0, 'x'])).toEqual({ ok: true, value: 'x' });
    expect(decodeResult([1, 'ACCESS_DENIED: no'])).toEqual({ ok: false, error: 'ACCESS_DENIED: no' });
    expect(() => decodeResult({ ok: 1 })).toThrow();
    expect(AGENT_PROCEDURE_FIELDS.AgentDataScope).toContain('exfiltrationStatus');
  });

  it('validates AI API payloads strictly', () => {
    expect(AiAnalyzeRequest.safeParse({ incident_id: 'i', run_id: 'r', analysis_type: 'impact' }).success).toBe(true);
    expect(AiAnalyzeRequest.safeParse({ incident_id: 'i', analysis_type: 'impact' }).success).toBe(false);
    expect(AiAnalyzeRequest.safeParse({ incident_id: 'i', run_id: 'r', analysis_type: 'impact', role: 'OWNER' }).success).toBe(false);
    const base = { run_id: 'r', status: 'completed', inference_mode: 'LIVE', model_identifier: 'm', verified_facts: [], uncertainties: [] };
    const action = { title: 'Preserve logs', description: '', priority: 'P1', rationale: 'because evidence says so' };
    expect(AiAnalyzeResponse.safeParse({ ...base, proposed_actions: [{ ...action, evidence_ids: [], uncertainties: [] }] }).success).toBe(false);
    expect(AiAnalyzeResponse.safeParse({ ...base, proposed_actions: [{ ...action, evidence_ids: ['e1'], uncertainties: [] }] }).success).toBe(true);
    expect(AiAnalyzeResponse.safeParse({ ...base, verified_facts: [{ statement: 'x', evidence_ids: [], verification: 'CONFIRMED' }], proposed_actions: [] }).success).toBe(false);
    expect(toHttpRunStatus('EXPIRED')).toBe('failed');
  });
});

describe('audit hash', () => {
  const fields = {
    organizationId: 'o',
    incidentId: 'i',
    seq: 1n,
    actorHex: 'ab',
    actorKind: 'USER',
    eventType: 'X',
    targetId: 't',
    timestampMicros: 1n,
    metadata: '{}',
    previousHash: AUDIT_GENESIS_HASH,
  };
  it('is deterministic and sensitive to every field', () => {
    const h = computeAuditHash(fields);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeAuditHash({ ...fields })).toBe(h);
    for (const [k, v] of Object.entries(fields)) {
      const changed = { ...fields, [k]: typeof v === 'bigint' ? v + 1n : `${v}x` };
      expect(computeAuditHash(changed), k).not.toBe(h);
    }
  });
});
