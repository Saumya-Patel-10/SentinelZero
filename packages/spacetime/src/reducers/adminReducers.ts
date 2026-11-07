import { t, ScheduleAt } from 'spacetimedb/server';
import spacetimedb from '../schema';
import { fail, newId } from '../security/context';
import { appendAudit } from '../security/audit';
import {
  activeMembership,
  activeMembershipsOf,
  activeServicePrincipal,
  isAnyActiveServicePrincipal,
  isPlatformAdmin,
  requireOrgCapability,
} from '../security/membership';
import { oneOf, text } from '../security/validation';
import { DATA_CLASSES, ROLES } from '../../../shared/src/enums';
import { LIMITS } from '../../../shared/src/limits';

/** The publishing identity becomes the first platform admin; starts the agent-run sweep. */
export const init = spacetimedb.init(ctx => {
  if (!ctx.db.platformAdmin.identity.find(ctx.sender)) {
    ctx.db.platformAdmin.insert({ identity: ctx.sender, createdAt: ctx.timestamp });
  }
  if (ctx.db.agentRunSweepSchedule.count() === 0n) {
    ctx.db.agentRunSweepSchedule.insert({ scheduledId: 0n, scheduledAt: ScheduleAt.interval(60_000_000n) });
  }
});

/**
 * Optional issuer allowlist: once any trusted_issuer row exists, connections whose JWT issuer
 * is not listed are rejected. Empty table = any issuer accepted by the SpacetimeDB host (dev).
 */
export const onConnect = spacetimedb.clientConnected(ctx => {
  if (ctx.db.trustedIssuer.count() === 0n) return;
  const issuer = ctx.senderAuth.jwt?.issuer;
  if (!issuer || !ctx.db.trustedIssuer.issuer.find(issuer)) {
    fail('AUTH_REQUIRED', 'token issuer is not trusted');
  }
});

export const add_trusted_issuer = spacetimedb.reducer({ issuer: t.string() }, (ctx, { issuer }) => {
  if (!isPlatformAdmin(ctx.db, ctx.sender)) fail('ACCESS_DENIED', 'platform admin only');
  text('issuer', issuer, LIMITS.EVIDENCE_SOURCE);
  if (!ctx.db.trustedIssuer.issuer.find(issuer)) {
    ctx.db.trustedIssuer.insert({ issuer, addedBy: ctx.sender, addedAt: ctx.timestamp });
  }
});

export const remove_trusted_issuer = spacetimedb.reducer({ issuer: t.string() }, (ctx, { issuer }) => {
  if (!isPlatformAdmin(ctx.db, ctx.sender)) fail('ACCESS_DENIED', 'platform admin only');
  ctx.db.trustedIssuer.issuer.delete(issuer);
});

export const create_organization = spacetimedb.reducer(
  { name: t.string(), dataClass: t.string() },
  (ctx, { name, dataClass }) => {
    if (!isPlatformAdmin(ctx.db, ctx.sender)) fail('ACCESS_DENIED', 'platform admin only');
    text('name', name, LIMITS.ORG_NAME);
    oneOf('dataClass', DATA_CLASSES, dataClass);
    if (isAnyActiveServicePrincipal(ctx.db, ctx.sender)) fail('ACCESS_DENIED', 'service principals cannot own organizations');
    const id = newId(ctx);
    ctx.db.organization.insert({ id, name, status: 'ACTIVE', dataClass, createdBy: ctx.sender, createdAt: ctx.timestamp });
    const membershipId = newId(ctx);
    ctx.db.membership.insert({
      id: membershipId,
      organizationId: id,
      userIdentity: ctx.sender,
      role: 'OWNER',
      grantedBy: ctx.sender,
      createdAt: ctx.timestamp,
      revokedAt: undefined,
      revokedBy: undefined,
      revokeReason: '',
    });
    appendAudit(ctx, { organizationId: id, actorKind: 'USER', eventType: 'ORGANIZATION_CREATED', targetId: id, metadata: { dataClass } });
    appendAudit(ctx, {
      organizationId: id,
      actorKind: 'USER',
      eventType: 'MEMBER_INVITED',
      targetId: membershipId,
      metadata: { role: 'OWNER', member: ctx.sender.toHexString() },
    });
  }
);

export const register_profile = spacetimedb.reducer({ displayName: t.string() }, (ctx, { displayName }) => {
  text('displayName', displayName, LIMITS.DISPLAY_NAME);
  const existing = ctx.db.userProfile.identity.find(ctx.sender);
  if (existing) {
    if (existing.disabledAt !== undefined) fail('ACCESS_DENIED', 'account disabled');
    ctx.db.userProfile.identity.update({ ...existing, displayName, updatedAt: ctx.timestamp });
  } else {
    ctx.db.userProfile.insert({
      identity: ctx.sender,
      displayName,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      disabledAt: undefined,
    });
  }
});

/** Platform-wide kill switch for a user identity (e.g. stolen session). */
export const set_user_disabled = spacetimedb.reducer(
  { userIdentity: t.identity(), disabled: t.bool() },
  (ctx, { userIdentity, disabled }) => {
    if (!isPlatformAdmin(ctx.db, ctx.sender)) fail('ACCESS_DENIED', 'platform admin only');
    const existing = ctx.db.userProfile.identity.find(userIdentity);
    const disabledAt = disabled ? ctx.timestamp : undefined;
    if (existing) {
      ctx.db.userProfile.identity.update({ ...existing, disabledAt, updatedAt: ctx.timestamp });
    } else {
      ctx.db.userProfile.insert({ identity: userIdentity, displayName: '', createdAt: ctx.timestamp, updatedAt: ctx.timestamp, disabledAt });
    }
    for (const m of ctx.db.membership.userIdentity.filter(userIdentity)) {
      if (m.revokedAt !== undefined) continue;
      appendAudit(ctx, {
        organizationId: m.organizationId,
        actorKind: 'PLATFORM',
        eventType: disabled ? 'USER_DISABLED' : 'USER_ENABLED',
        targetId: userIdentity.toHexString(),
      });
    }
  }
);

export const invite_member = spacetimedb.reducer(
  { organizationId: t.string(), userIdentity: t.identity(), role: t.string() },
  (ctx, { organizationId, userIdentity, role }) => {
    requireOrgCapability(ctx, organizationId, 'MANAGE_MEMBERS');
    oneOf('role', ROLES, role);
    if (isAnyActiveServicePrincipal(ctx.db, userIdentity)) fail('VALIDATION_FAILED', 'service principals cannot hold membership roles');
    if (activeMembership(ctx.db, organizationId, userIdentity)) fail('VALIDATION_FAILED', 'identity already has an active membership');
    const id = newId(ctx);
    ctx.db.membership.insert({
      id,
      organizationId,
      userIdentity,
      role,
      grantedBy: ctx.sender,
      createdAt: ctx.timestamp,
      revokedAt: undefined,
      revokedBy: undefined,
      revokeReason: '',
    });
    appendAudit(ctx, {
      organizationId,
      actorKind: 'USER',
      eventType: 'MEMBER_INVITED',
      targetId: id,
      metadata: { role, member: userIdentity.toHexString() },
    });
  }
);

export const revoke_member = spacetimedb.reducer(
  { membershipId: t.string(), reason: t.string() },
  (ctx, { membershipId, reason }) => {
    const m = ctx.db.membership.id.find(membershipId);
    if (!m) fail('NOT_FOUND', 'membership not found');
    requireOrgCapability(ctx, m.organizationId, 'MANAGE_MEMBERS');
    text('reason', reason, LIMITS.REASON);
    if (m.revokedAt !== undefined) return; // idempotent
    if (m.role === 'OWNER') {
      let owners = 0;
      for (const other of ctx.db.membership.by_org_user.filter(m.organizationId)) {
        if (other.role === 'OWNER' && other.revokedAt === undefined) owners++;
      }
      if (owners <= 1) fail('VALIDATION_FAILED', 'cannot revoke the last OWNER');
    }
    ctx.db.membership.id.update({ ...m, revokedAt: ctx.timestamp, revokedBy: ctx.sender, revokeReason: reason });
    appendAudit(ctx, {
      organizationId: m.organizationId,
      actorKind: 'USER',
      eventType: 'MEMBER_REVOKED',
      targetId: m.id,
      metadata: { role: m.role, member: m.userIdentity.toHexString() },
    });
  }
);

export const register_service_principal = spacetimedb.reducer(
  { organizationId: t.string(), identity: t.identity(), label: t.string() },
  (ctx, { organizationId, identity, label }) => {
    requireOrgCapability(ctx, organizationId, 'MANAGE_SERVICE_PRINCIPALS');
    text('label', label, LIMITS.SHORT_TEXT);
    if (identity.isEqual(ctx.sender)) fail('VALIDATION_FAILED', 'cannot register yourself as a service principal');
    if (activeMembershipsOf(ctx.db, identity).length > 0) fail('VALIDATION_FAILED', 'identity holds a human membership');
    if (isPlatformAdmin(ctx.db, identity)) fail('VALIDATION_FAILED', 'platform admins cannot be service principals');
    if (activeServicePrincipal(ctx.db, organizationId, identity)) return; // idempotent
    const id = newId(ctx);
    ctx.db.servicePrincipal.insert({
      id,
      organizationId,
      identity,
      label,
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      revokedAt: undefined,
    });
    appendAudit(ctx, {
      organizationId,
      actorKind: 'USER',
      eventType: 'SERVICE_PRINCIPAL_REGISTERED',
      targetId: id,
      metadata: { label, principal: identity.toHexString() },
    });
  }
);

export const revoke_service_principal = spacetimedb.reducer({ servicePrincipalId: t.string() }, (ctx, { servicePrincipalId }) => {
  const sp = ctx.db.servicePrincipal.id.find(servicePrincipalId);
  if (!sp) fail('NOT_FOUND', 'service principal not found');
  requireOrgCapability(ctx, sp.organizationId, 'MANAGE_SERVICE_PRINCIPALS');
  if (sp.revokedAt !== undefined) return;
  ctx.db.servicePrincipal.id.update({ ...sp, revokedAt: ctx.timestamp });
  appendAudit(ctx, { organizationId: sp.organizationId, actorKind: 'USER', eventType: 'SERVICE_PRINCIPAL_REVOKED', targetId: sp.id });
});
