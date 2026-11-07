import type { Identity } from 'spacetimedb';
import type { ReadDb } from '../security/context';
import { orgsWithCapability } from '../security/membership';
import type { Capability } from '../../../shared/src/permissions';

/** Rows of an incident-scoped table across every incident the viewer may see with `capability`. */
export function incidentScoped<Row>(db: ReadDb, viewer: Identity, capability: Capability, rowsOf: (incidentId: string) => Iterable<Row>): Row[] {
  const out: Row[] = [];
  for (const orgId of orgsWithCapability(db, viewer, capability)) {
    for (const inc of db.incident.organizationId.filter(orgId)) {
      for (const row of rowsOf(inc.id)) out.push(row);
    }
  }
  return out;
}
