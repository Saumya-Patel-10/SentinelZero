import { t } from 'spacetimedb/server';
import spacetimedb, { agentRun, agentToolCall, auditEvent, recommendation, servicePrincipal, task } from '../schema';
import { orgsWithCapability } from '../security/membership';
import { incidentScoped } from './scope';

export const my_tasks = spacetimedb.view({ name: 'my_tasks', public: true }, t.array(task.rowType), ctx =>
  incidentScoped(ctx.db, ctx.sender, 'VIEW_TASKS', id => ctx.db.task.incidentId.filter(id))
);

export const my_agent_runs = spacetimedb.view({ name: 'my_agent_runs', public: true }, t.array(agentRun.rowType), ctx =>
  incidentScoped(ctx.db, ctx.sender, 'VIEW_AGENT_ACTIVITY', id => ctx.db.agentRun.incidentId.filter(id))
);

export const my_agent_tool_calls = spacetimedb.view({ name: 'my_agent_tool_calls', public: true }, t.array(agentToolCall.rowType), ctx =>
  incidentScoped(ctx.db, ctx.sender, 'VIEW_AGENT_ACTIVITY', id => ctx.db.agentToolCall.incidentId.filter(id))
);

export const my_recommendations = spacetimedb.view({ name: 'my_recommendations', public: true }, t.array(recommendation.rowType), ctx =>
  incidentScoped(ctx.db, ctx.sender, 'VIEW_AGENT_ACTIVITY', id => ctx.db.recommendation.incidentId.filter(id))
);

/** Incident-level and organization-level audit events. OWNER/COMMANDER/ANALYST only. */
export const my_audit_events = spacetimedb.view({ name: 'my_audit_events', public: true }, t.array(auditEvent.rowType), ctx =>
  orgsWithCapability(ctx.db, ctx.sender, 'VIEW_AUDIT').flatMap(orgId => [...ctx.db.auditEvent.organizationId.filter(orgId)])
);

/** OWNER only. */
export const my_service_principals = spacetimedb.view({ name: 'my_service_principals', public: true }, t.array(servicePrincipal.rowType), ctx =>
  orgsWithCapability(ctx.db, ctx.sender, 'MANAGE_SERVICE_PRINCIPALS').flatMap(orgId => [
    ...ctx.db.servicePrincipal.by_org_identity.filter(orgId),
  ])
);
