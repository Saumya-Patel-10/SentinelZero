// Runs the SpacetimeDB CLI from $SPACETIME_CLI (falls back to `spacetime` on PATH) with the given args.
import { spawnSync } from 'node:child_process';

const cli = process.env.SPACETIME_CLI || 'spacetime';
const r = spawnSync(cli, process.argv.slice(2), { stdio: 'inherit' });
if (r.error) {
  console.error(`could not run ${cli}: ${r.error.message}. Set SPACETIME_CLI to the 2.14.1 CLI path.`);
  process.exit(1);
}
process.exit(r.status ?? 1);
