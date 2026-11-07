/**
 * Canonical Domain Contracts for SentinelZero
 * Strictly aligned with ARCHITECTURE.md and architecture.json
 */

import { z } from 'zod';

export type Role = 'OWNER' | 'COMMANDER' | 'ANALYST' | 'RESPONDER' | 'OBSERVER';

export type IncidentStatus = 
  | 'REPORTED'
  | 'TRIAGING'
  | 'INVESTIGATING'
  | 'CONTAINING'
  | 'CONTAINED'
  | 'RECOVERING'
  | 'RESOLVED'
  | 'CLOSED';

export const ALLOWED_STATUS_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  REPORTED: ['TRIAGING', 'CLOSED'],
  TRIAGING: ['INVESTIGATING', 'CLOSED'],
  INVESTIGATING: ['CONTAINING', 'CLOSED'],
  CONTAINING: ['CONTAINED', 'INVESTIGATING'],
  CONTAINED: ['RECOVERING', 'CONTAINING'],
  RECOVERING: ['RESOLVED', 'CONTAINING'],
  RESOLVED: ['CLOSED', 'RECOVERING'],
  CLOSED: ['TRIAGING'], // Re-open requires Commander authorization
};

export type VerificationStatus = 'UNKNOWN' | 'SUSPECTED' | 'CONFIRMED' | 'RULED_OUT';

export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type IncidentCategory = 
  | 'RANSOMWARE'
  | 'EXFILTRATION'
  | 'MALWARE'
  | 'PHISHING'
  | 'DENIAL_OF_SERVICE'
  | 'INSIDER_THREAT'
  | 'OTHER';

export type AssetType = 
  | 'DATABASE'
  | 'SERVER'
  | 'WORKSTATION'
  | 'NETWORK_DEVICE'
  | 'CLOUD_SERVICE'
  | 'IDENTITY_PROVIDER'
  | 'EHR_SYSTEM'
  | 'BACKUP_SYSTEM';

export type AssetCriticality = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type TaskStatus = 
  | 'PENDING'
  | 'AWAITING_APPROVAL'
  | 'IN_PROGRESS'
  | 'BLOCKED'
  | 'COMPLETED'
  | 'CANCELLED';

export type TaskApprovalStatus = 'NOT_REQUIRED' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

export type AgentRunStatus = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

// Core Interfaces
export interface Organization {
  id: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED';
  created_at: string;
}

export interface UserProfile {
  id: string;
  auth_identity: string;
  display_name: string;
  email: string;
  role: Role;
  disabled_at?: string | null;
}

export interface Incident {
  id: string;
  organization_id: string;
  title: string;
  description: string;
  category: IncidentCategory;
  severity: IncidentSeverity;
  status: IncidentStatus;
  commander_identity: string;
  detected_at: string;
  reported_at: string;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface Asset {
  id: string;
  organization_id: string;
  incident_id: string;
  name: string;
  type: AssetType;
  criticality: AssetCriticality;
  compromise_status: VerificationStatus;
  availability_status: VerificationStatus;
  last_verified_at: string;
  ip_address?: string;
  fqdn?: string;
  location?: string;
}

export interface ServiceDependency {
  id: string;
  organization_id: string;
  source_asset_id: string;
  target_service_id: string;
  type: 'HARD_DEPENDENCY' | 'FAILOVER' | 'DATA_FEED';
  confidence: number; // 0.0 - 1.0
  verified_at: string;
}

export interface OperationalImpact {
  id: string;
  organization_id: string;
  incident_id: string;
  service_id: string;
  service_name: string;
  impact_type: 'OUTAGE' | 'DEGRADED' | 'ISOLATED' | 'DATA_RISK';
  severity: IncidentSeverity;
  verification_status: VerificationStatus;
  description: string;
  affected_groups: string[]; // e.g., ["Emergency Dept", "ICU Staff", "Billing"]
}

export interface DataScope {
  id: string;
  organization_id: string;
  incident_id: string;
  asset_id: string;
  data_category: 'PHI' | 'PII' | 'FINANCIAL' | 'INTELLECTUAL_PROPERTY' | 'OPERATIONAL_LOGS';
  sensitivity: 'RESTRICTED' | 'CONFIDENTIAL' | 'INTERNAL' | 'PUBLIC';
  lock_status: VerificationStatus;
  exfiltration_status: VerificationStatus;
  integrity_status: VerificationStatus;
  estimated_records: number;
  confidence: number;
  evidence_reference?: string;
}

export interface Task {
  id: string;
  organization_id: string;
  incident_id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assigned_identity: string;
  assigned_name?: string;
  approval_status: TaskApprovalStatus;
  approved_by?: string | null;
  version: number;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  is_ai_proposed?: boolean;
}

export interface Message {
  id: string;
  organization_id: string;
  incident_id: string;
  sender_identity: string;
  sender_name: string;
  sender_role: Role;
  content: string;
  created_at: string;
  message_type: 'STANDARD' | 'COMMAND_DIRECTIVE' | 'SITREP' | 'SYSTEM_ALERT';
}

export interface EvidenceReference {
  id: string;
  organization_id: string;
  incident_id: string;
  type: 'DISK_IMAGE' | 'MEMORY_DUMP' | 'PCAP' | 'LOG_EXPORT' | 'RANSOM_NOTE' | 'IOC_LIST';
  source: string;
  sha256: string;
  classification: 'TLP_RED' | 'TLP_AMBER' | 'TLP_GREEN' | 'TLP_CLEAR';
  recorded_at: string;
  summary: string;
}

export interface AuditEvent {
  id: string;
  organization_id: string;
  incident_id: string;
  actor_identity: string;
  actor_name: string;
  event_type: string;
  target_id: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  previous_hash: string;
  event_hash: string;
}

export interface AgentRun {
  id: string;
  organization_id: string;
  incident_id: string;
  requested_by: string;
  model_identifier: string;
  status: AgentRunStatus;
  started_at: string;
  finished_at?: string | null;
  error_category?: string | null;
  summary?: string;
}

export interface AgentToolCall {
  id: string;
  agent_run_id: string;
  tool_name: string;
  input_summary: string;
  output_summary: string;
  status: 'PENDING' | 'EXECUTED' | 'FAILED';
  timestamp: string;
}

export interface AgentRecommendation {
  id: string;
  agent_run_id: string;
  incident_id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  category: 'CONTAINMENT' | 'EVIDENCE_PRESERVATION' | 'CONTINUITY' | 'ERADICATION';
  rationale: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  proposed_task: {
    title: string;
    description: string;
    priority: TaskPriority;
    assigned_identity: string;
  };
  created_at: string;
}

// Zod Validation Schemas
export const IncidentFormSchema = z.object({
  title: z.string().min(5, 'Title must be at least 5 characters').max(120, 'Title too long'),
  description: z.string().min(10, 'Description must be at least 10 characters').max(2000),
  category: z.enum(['RANSOMWARE', 'EXFILTRATION', 'MALWARE', 'PHISHING', 'DENIAL_OF_SERVICE', 'INSIDER_THREAT', 'OTHER']),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  commander_identity: z.string().min(1, 'Commander assignment required'),
});

export type IncidentFormValues = z.infer<typeof IncidentFormSchema>;

export const TaskFormSchema = z.object({
  title: z.string().min(3, 'Title required').max(120),
  description: z.string().min(5, 'Description required').max(1000),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  assigned_identity: z.string().min(1, 'Assignee required'),
  requires_approval: z.boolean().default(false),
});

export type TaskFormValues = z.infer<typeof TaskFormSchema>;

export const MessageFormSchema = z.object({
  content: z.string().min(1, 'Message cannot be empty').max(1000),
  message_type: z.enum(['STANDARD', 'COMMAND_DIRECTIVE', 'SITREP', 'SYSTEM_ALERT']).default('STANDARD'),
});

export type MessageFormValues = z.infer<typeof MessageFormSchema>;

