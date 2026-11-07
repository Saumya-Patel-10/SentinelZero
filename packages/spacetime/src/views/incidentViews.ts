import { t } from 'spacetimedb/server';
import spacetimedb, { incident, membership, organization, userProfile } from '../schema';
import { activeMembershipsOf, orgsWithCapability } from '../security/membership';

// All views are `public: true` only so clients can subscribe; their CONTENT is filtered per
// ctx.sender. A view returns nothing for identities without an active membership.

const MemberDirectoryEntry = t.row('MemberDirectoryEntry', {
  membershipId: t.string().primaryKey(),
  organizationId: t.string(),
  userIdentity: t.identity(),
  displayName: t.string(),
  role: t.string(),
});

const IncidentSummary = t.row('IncidentSummary', {
  id: t.string().primaryKey(),
  organizationId: t.string(),
  title: t.string(),
  category: t.string(),
  severity: t.string(),
  status: t.string(),
  dataClass: t.string(),
  reportedAt: t.timestamp(),
  updatedAt: t.timestamp(),
});

/** The caller's own memberships, including revoked ones (so the UI can show "access revoked"). */
export const my_memberships = spacetimedb.view({ name: 'my_memberships', public: true }, t.array(membership.rowType), ctx => [
  ...ctx.db.membership.userIdentity.filter(ctx.sender),
]);

export const my_profile = spacetimedb.view({ name: 'my_profile', public: true }, t.option(userProfile.rowType), ctx =>
  ctx.db.userProfile.identity.find(ctx.sender) ?? undefined
);

export const my_organizations = spacetimedb.view({ name: 'my_organizations', public: true }, t.array(organization.rowType), ctx =>
  activeMembershipsOf(ctx.db, ctx.sender)
    .map(m => ctx.db.organization.id.find(m.organizationId))
    .filter(o => o != null)
);

export const org_member_directory = spacetimedb.view(
  { name: 'org_member_directory', public: true },
  t.array(MemberDirectoryEntry),
  ctx => {
    const out: Array<{ membershipId: string; organizationId: string; userIdentity: typeof ctx.sender; displayName: string; role: string }> = [];
    for (const orgId of orgsWithCapability(ctx.db, ctx.sender, 'VIEW_MEMBER_DIRECTORY')) {
      for (const m of ctx.db.membership.by_org_user.filter(orgId)) {
        if (m.revokedAt !== undefined) continue;
        out.push({
          membershipId: m.id,
          organizationId: m.organizationId,
          userIdentity: m.userIdentity,
          displayName: ctx.db.userProfile.identity.find(m.userIdentity)?.displayName ?? '',
          role: m.role,
        });
      }
    }
    return out;
  }
);

export const my_incidents = spacetimedb.view({ name: 'my_incidents', public: true }, t.array(incident.rowType), ctx =>
  orgsWithCapability(ctx.db, ctx.sender, 'VIEW_INCIDENT_DETAIL').flatMap(orgId => [...ctx.db.incident.organizationId.filter(orgId)])
);

/** Limited projection available to every role, including OBSERVER. */
export const my_incident_summaries = spacetimedb.view({ name: 'my_incident_summaries', public: true }, t.array(IncidentSummary), ctx =>
  orgsWithCapability(ctx.db, ctx.sender, 'VIEW_INCIDENT_SUMMARY').flatMap(orgId =>
    [...ctx.db.incident.organizationId.filter(orgId)].map(i => ({
      id: i.id,
      organizationId: i.organizationId,
      title: i.title,
      category: i.category,
      severity: i.severity,
      status: i.status,
      dataClass: i.dataClass,
      reportedAt: i.reportedAt,
      updatedAt: i.updatedAt,
    }))
  )
);
