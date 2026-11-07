import { adminActor, key, newActor, subscribe, waitFor, type Actor } from './client';
import type { Role } from '../../../shared/src/enums';

export interface Team {
  orgId: string;
  /** Platform admin; created the org and is therefore also an OWNER of it. */
  admin: Actor;
  /** A distinct, freshly enrolled OWNER unique to this team. */
  owner: Actor;
  commander: Actor;
  analyst: Actor;
  responder: Actor;
  observer: Actor;
  membershipIdOf: (a: Actor) => string;
}

/**
 * Creates an EXERCISE organization (platform admin), enrolls a team-specific OWNER, and has that
 * owner enroll one member per remaining role.
 */
export async function createTeam(label = 'org'): Promise<Team> {
  const admin = await adminActor();
  await subscribe(admin, ['SELECT * FROM my_organizations']);
  const name = `SZ Test ${label} ${key()}`.slice(0, 120);
  await admin.conn.reducers.createOrganization({ name, dataClass: 'EXERCISE' });
  const org = await waitFor('org created', () => [...admin.conn.db.myOrganizations.iter()].find(o => o.name === name));

  const owner = await newActor('owner');
  await owner.conn.reducers.registerProfile({ displayName: `owner ${label}` });
  await admin.conn.reducers.inviteMember({ organizationId: org.id, userIdentity: owner.identity, role: 'OWNER' });
  await subscribe(owner, ['SELECT * FROM my_organizations', 'SELECT * FROM org_member_directory']);

  const members: Record<Exclude<Role, 'OWNER'>, Actor> = {
    COMMANDER: await newActor('commander'),
    ANALYST: await newActor('analyst'),
    RESPONDER: await newActor('responder'),
    OBSERVER: await newActor('observer'),
  };
  for (const [role, actor] of Object.entries(members)) {
    await actor.conn.reducers.registerProfile({ displayName: `${role.toLowerCase()} ${label}` });
    await owner.conn.reducers.inviteMember({ organizationId: org.id, userIdentity: actor.identity, role });
  }

  const membershipIdOf = (a: Actor) => {
    const row = [...owner.conn.db.orgMemberDirectory.iter()].find(m => m.organizationId === org.id && m.userIdentity.isEqual(a.identity));
    if (!row) throw new Error(`no membership for ${a.name}`);
    return row.membershipId;
  };
  await waitFor('directory populated', () =>
    [...owner.conn.db.orgMemberDirectory.iter()].filter(m => m.organizationId === org.id).length === 6
  );

  return {
    orgId: org.id,
    admin,
    owner,
    commander: members.COMMANDER,
    analyst: members.ANALYST,
    responder: members.RESPONDER,
    observer: members.OBSERVER,
    membershipIdOf,
  };
}

export async function createIncident(actor: Actor, orgId: string, title = 'Ransomware on scheduling DB'): Promise<string> {
  await actor.conn.reducers.createIncident({
    organizationId: orgId,
    title,
    description: 'EXERCISE: synthetic incident',
    category: 'RANSOMWARE',
    severity: 'CRITICAL',
    detectedAt: undefined,
    idempotencyKey: key('inc'),
  });
  return title;
}

/** Creates an incident as `actor` (who must be subscribed to my_incidents) and returns its row. */
export async function newIncident(actor: Actor, orgId: string) {
  const title = `Incident ${key()}`;
  await createIncident(actor, orgId, title);
  return waitFor('incident visible', () => [...actor.conn.db.myIncidents.iter()].find(i => i.title === title));
}

export const ALL_VIEWS = [
  'my_incidents',
  'my_incident_summaries',
  'my_assets',
  'my_services',
  'my_service_dependencies',
  'my_operational_impacts',
  'my_data_scopes',
  'my_evidence',
  'my_tasks',
  'my_messages',
  'my_audit_events',
  'my_agent_runs',
  'my_agent_tool_calls',
  'my_recommendations',
  'my_memberships',
  'my_organizations',
  'org_member_directory',
  'my_service_principals',
] as const;

export const subscribeAll = (a: Actor) => subscribe(a, ALL_VIEWS.map(v => `SELECT * FROM ${v}`));

export const SHA = (seed: string) => seed.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a').slice(0, 64);
