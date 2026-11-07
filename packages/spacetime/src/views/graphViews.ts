import { t } from 'spacetimedb/server';
import spacetimedb, { asset, dataScope, evidenceReference, operationalImpact, service, serviceDependency } from '../schema';
import { incidentScoped } from './scope';

export const my_assets = spacetimedb.view({ name: 'my_assets', public: true }, t.array(asset.rowType), ctx =>
  incidentScoped(ctx.db, ctx.sender, 'VIEW_IMPACT_GRAPH', id => ctx.db.asset.incidentId.filter(id))
);

export const my_services = spacetimedb.view({ name: 'my_services', public: true }, t.array(service.rowType), ctx =>
  incidentScoped(ctx.db, ctx.sender, 'VIEW_IMPACT_GRAPH', id => ctx.db.service.incidentId.filter(id))
);

export const my_service_dependencies = spacetimedb.view(
  { name: 'my_service_dependencies', public: true },
  t.array(serviceDependency.rowType),
  ctx => incidentScoped(ctx.db, ctx.sender, 'VIEW_IMPACT_GRAPH', id => ctx.db.serviceDependency.incidentId.filter(id))
);

export const my_operational_impacts = spacetimedb.view(
  { name: 'my_operational_impacts', public: true },
  t.array(operationalImpact.rowType),
  ctx => incidentScoped(ctx.db, ctx.sender, 'VIEW_IMPACT_GRAPH', id => ctx.db.operationalImpact.incidentId.filter(id))
);

/** Sensitive: OWNER/COMMANDER/ANALYST only. */
export const my_data_scopes = spacetimedb.view({ name: 'my_data_scopes', public: true }, t.array(dataScope.rowType), ctx =>
  incidentScoped(ctx.db, ctx.sender, 'VIEW_DATA_SCOPE', id => ctx.db.dataScope.incidentId.filter(id))
);

/** Sensitive: OWNER/COMMANDER/ANALYST only. */
export const my_evidence = spacetimedb.view({ name: 'my_evidence', public: true }, t.array(evidenceReference.rowType), ctx =>
  incidentScoped(ctx.db, ctx.sender, 'VIEW_EVIDENCE', id => ctx.db.evidenceReference.incidentId.filter(id))
);
