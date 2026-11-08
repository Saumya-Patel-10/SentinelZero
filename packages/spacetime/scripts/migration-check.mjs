// Verifies that publishing NEW_BUNDLE over a database created by OLD_BUNDLE succeeds WITHOUT
// clearing data (SpacetimeDB automatic migration) and that existing rows survive.
//
//   node scripts/migration-check.mjs <old dist/bundle.js> <new dist/bundle.js>
//
// Env: SZ_STDB_URI (default http://127.0.0.1:3000). Uses a throwaway identity and database and
// deletes the database afterwards. Never prints tokens.
import { readFileSync } from 'node:fs';

const [oldBundle, newBundle] = process.argv.slice(2);
if (!oldBundle || !newBundle) {
  console.error('usage: node scripts/migration-check.mjs <old bundle.js> <new bundle.js>');
  process.exit(2);
}
const uri = process.env.SZ_STDB_URI ?? 'http://127.0.0.1:3000';
const db = `sz-migration-${Date.now().toString(36)}`;
const { token } = await (await fetch(`${uri}/v1/identity`, { method: 'POST' })).json();
const auth = { Authorization: `Bearer ${token}` };

async function publish(path, clear) {
  const res = await fetch(`${uri}/v1/database/${db}?host_type=Js${clear ? '&clear=true' : ''}`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/octet-stream' },
    body: readFileSync(path),
  });
  return { status: res.status, body: (await res.text()).slice(0, 300) };
}
const sql = async q =>
  (await fetch(`${uri}/v1/database/${db}/sql`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: q })).json();

let ok = false;
try {
  const p1 = await publish(oldBundle, true);
  console.log('publish old (clear):', p1.status);
  const call = await fetch(`${uri}/v1/database/${db}/call/create_organization`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(['Migration Check Org', 'EXERCISE']),
  });
  console.log('create_organization on old schema:', call.status);
  const p2 = await publish(newBundle, false);
  console.log('publish new (no clear):', p2.status, p2.status >= 300 ? p2.body : '');
  const orgs = (await sql('SELECT name FROM my_organizations'))[0].rows;
  const audit = (await sql('SELECT seq FROM my_audit_events'))[0].rows;
  const info = await sql('SELECT * FROM backend_info');
  console.log('organizations after upgrade:', JSON.stringify(orgs));
  console.log('audit events after upgrade:', audit.length);
  console.log('backend_info after upgrade:', JSON.stringify(info[0]?.rows ?? info));
  ok = p1.status < 300 && call.status === 200 && p2.status < 300 && orgs.some(r => r[0] === 'Migration Check Org') && audit.length >= 2;
} finally {
  await fetch(`${uri}/v1/database/${db}`, { method: 'DELETE', headers: auth });
}
console.log(ok ? 'MIGRATION CHECK PASSED' : 'MIGRATION CHECK FAILED');
process.exit(ok ? 0 : 1);
