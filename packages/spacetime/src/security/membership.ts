import type { Identity } from 'spacetimedb';
import { fail, type Ctx, type ReadDb } from './context';
import { roleHas, type Capability } from '../../../shared/src/permissions';
import type { Role } from '../../../shared/src/enums';

type MembershipRow = NonNullable<ReturnType<ReadDb['membership']['id']['find']>>;
type IncidentRow = NonNullable<ReturnType<ReadDb['incident']['id']['find']>>;
type ServicePrincipalRow = NonNullable<ReturnType<ReadDb['servicePrincipal']['id']['find']>>;

export function isPlatformAdmin(db: ReadDb, identity: Identity): boolean {
  return db.platformAdmin.identity.find(identity) != null;
}

export function isUserDisabled(db: ReadDb, identity: Identity): boolean {
  const profile = db.userProfile.identity.find(identity);
  return profile != null && profile.disabledAt !== undefined;
}

function isOrgActive(db: ReadDb, organizationId: string): boolean {
  const org = db.organization.id.find(organizationId);
  return org != null && org.status === 'ACTIVE';
}

/**
 * The single source of truth for "does this identity currently belong to this org".
 * Used by reducers, procedures AND views, so revocation/disable/suspension take effect everywhere.
 */
export function activeMembership(db: ReadDb, organizationId: string, identity: Identity): MembershipRow | undefined {
  if (!isOrgActive(db, organizationId) || isUserDisabled(db, identity)) return undefined;
  for (const m of db.membership.by_org_user.filter([organizationId, identity])) {
    if (m.revokedAt === undefined) return m;
  }
  return undefined;
}

/** All active memberships of `identity`, for view fan-out. */
export function activeMembershipsOf(db: ReadDb, identity: Identity): MembershipRow[] {
  if (isUserDisabled(db, identity)) return [];
  const out: MembershipRow[] = [];
  for (const m of db.membership.userIdentity.filter(identity)) {
    if (m.revokedAt === undefined && isOrgActive(db, m.organizationId)) out.push(m);
  }
  return out;
}

/**
 * Any unrevoked membership row, ignoring user-disable and organization status. Use for
 * role-separation invariants, where a temporarily disabled member is still a human member.
 */
export function hasUnrevokedMembership(db: ReadDb, identity: Identity): boolean {
  for (const m of db.membership.userIdentity.filter(identity)) {
    if (m.revokedAt === undefined) return true;
  }
  return false;
}

export function activeServicePrincipal(db: ReadDb, organizationId: string, identity: Identity): ServicePrincipalRow | undefined {
  if (!isOrgActive(db, organizationId)) return undefined;
  for (const sp of db.servicePrincipal.by_org_identity.filter([organizationId, identity])) {
    if (sp.revokedAt === undefined) return sp;
  }
  return undefined;
}

export function isAnyActiveServicePrincipal(db: ReadDb, identity: Identity): boolean {
  for (const sp of db.servicePrincipal.identity.filter(identity)) {
    if (sp.revokedAt === undefined) return true;
  }
  return false;
}

export function requireOrgCapability(ctx: Ctx, organizationId: string, capability: Capability): MembershipRow {
  const m = activeMembership(ctx.db, organizationId, ctx.sender);
  if (!m) fail('ACCESS_DENIED', 'not an active member of this organization');
  if (!roleHas(m.role as Role, capability)) fail('ACCESS_DENIED', `role ${m.role} lacks ${capability}`);
  return m;
}

/**
 * Loads an incident and checks the caller's capability on it.
 * Non-members receive INCIDENT_NOT_FOUND so incident existence is not disclosed across tenants.
 */
export function requireIncidentCapability(
  ctx: Ctx,
  incidentId: string,
  capability: Capability
): { incident: IncidentRow; membership: MembershipRow } {
  const inc = ctx.db.incident.id.find(incidentId);
  if (!inc) fail('INCIDENT_NOT_FOUND', 'incident not found');
  const m = activeMembership(ctx.db, inc.organizationId, ctx.sender);
  if (!m) fail('INCIDENT_NOT_FOUND', 'incident not found');
  if (!roleHas(m.role as Role, capability)) fail('ACCESS_DENIED', `role ${m.role} lacks ${capability}`);
  return { incident: inc, membership: m };
}

/** For view filtering: does `identity` hold `capability` in `organizationId` right now? */
export function canInOrg(db: ReadDb, organizationId: string, identity: Identity, capability: Capability): boolean {
  const m = activeMembership(db, organizationId, identity);
  return m != null && roleHas(m.role as Role, capability);
}

/** Orgs where `identity` currently holds `capability`. */
export function orgsWithCapability(db: ReadDb, identity: Identity, capability: Capability): string[] {
  return activeMembershipsOf(db, identity)
    .filter(m => roleHas(m.role as Role, capability))
    .map(m => m.organizationId);
}
