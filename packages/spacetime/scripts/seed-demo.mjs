// Seeds a LOCAL demo database with one EXERCISE organization, one account per role, and a
// registered AI service principal, using only the public SpacetimeDB HTTP API.
//
//   node scripts/seed-demo.mjs --publish      # publish dist/bundle.js to a fresh database first
//   node scripts/seed-demo.mjs                # seed an existing database (needs SZ_ADMIN_TOKEN)
//
// Env: SZ_STDB_URI (default http://127.0.0.1:3000), SZ_DB (default sentinelzero),
//      SZ_ADMIN_TOKEN (platform-admin token; required without --publish).
//
// Output: .demo/demo-accounts.json (git-ignored). It contains BEARER TOKENS for local
// development identities. They are server-minted, never expire, and only work while the issuer
// policy is OPEN. Do not copy them anywhere else. Tokens are never printed to the console.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const uri = process.env.SZ_STDB_URI ?? 'http://127.0.0.1:3000';
const db = process.env.SZ_DB ?? 'sentinelzero';
const publish = process.argv.includes('--publish');

const mint = async () => (await (await fetch(`${uri}/v1/identity`, { method: 'POST' })).json());
const id = hex => [`0x${hex}`];

async function call(token, fn, args) {
  const res = await fetch(`${uri}/v1/database/${db}/call/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${fn} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}
async function sql(token, query) {
  const res = await fetch(`${uri}/v1/database/${db}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` },
    body: query,
  });
  if (!res.ok) throw new Error(`sql failed: HTTP ${res.status}`);
  return (await res.json())[0].rows;
}

let admin;
if (publish) {
  admin = await mint();
  const res = await fetch(`${uri}/v1/database/${db}?clear=true&host_type=Js`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${admin.token}`, 'Content-Type': 'application/octet-stream' },
    body: readFileSync(join(root, 'dist', 'bundle.js')),
  });
  if (!res.ok) throw new Error(`publish failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  console.log(`published ${db} (data cleared); the minted publisher identity is the platform admin`);
} else {
  if (!process.env.SZ_ADMIN_TOKEN) throw new Error('SZ_ADMIN_TOKEN is required without --publish');
  admin = { token: process.env.SZ_ADMIN_TOKEN, identity: '' };
}

const orgName = `EXERCISE Regional Hospital ${new Date().toISOString().slice(0, 10)}`;
await call(admin.token, 'create_organization', [orgName, 'EXERCISE']);
const org = (await sql(admin.token, 'SELECT id, name FROM my_organizations')).find(r => r[1] === orgName);
if (!org) throw new Error('organization not visible after creation');
const orgId = org[0];

const roles = ['OWNER', 'COMMANDER', 'ANALYST', 'RESPONDER', 'OBSERVER'];
const accounts = {};
for (const role of roles) {
  const who = await mint();
  await call(who.token, 'register_profile', [`Demo ${role.charAt(0)}${role.slice(1).toLowerCase()}`]);
  accounts[role] = { identity: who.identity, token: who.token };
}
await call(admin.token, 'invite_member', [orgId, id(accounts.OWNER.identity), 'OWNER']);
for (const role of roles.slice(1)) await call(accounts.OWNER.token, 'invite_member', [orgId, id(accounts[role].identity), role]);

const ai = await mint();
await call(accounts.OWNER.token, 'register_service_principal', [orgId, id(ai.identity), 'sentinelzero-ai']);

await call(accounts.ANALYST.token, 'create_incident', [
  orgId,
  'EXERCISE: Ransomware on outpatient scheduling',
  'Synthetic exercise incident created by seed-demo.mjs. Not a real event.',
  'RANSOMWARE',
  'CRITICAL',
  { none: [] },
  `seed-${Date.now().toString(36)}`,
]);

const out = {
  warning: 'LOCAL DEVELOPMENT ONLY. Bearer tokens for EXERCISE identities. Never commit or share.',
  stdbUri: uri,
  database: db,
  organizationId: orgId,
  organizationName: orgName,
  platformAdmin: publish ? { identity: admin.identity, token: admin.token } : { identity: '(existing)', token: '(from SZ_ADMIN_TOKEN)' },
  accounts,
  aiServicePrincipal: { identity: ai.identity, token: ai.token, label: 'sentinelzero-ai' },
};
mkdirSync(join(root, '.demo'), { recursive: true });
writeFileSync(join(root, '.demo', 'demo-accounts.json'), JSON.stringify(out, null, 2));

console.log(`organization ${orgId} (${orgName})`);
for (const role of roles) console.log(`  ${role.padEnd(9)} ${accounts[role].identity}`);
console.log(`  AI SP     ${ai.identity}`);
console.log('tokens written to packages/spacetime/.demo/demo-accounts.json (git-ignored)');
