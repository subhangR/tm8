// The ONE way the rig reaches the dev node. Every write the rig makes (fixture,
// headers, lane spawn/terminate, replica copies) goes through here.
//
// TM8_CLI must name a wrapper that targets the dev node itself (README step 3:
// TM8_BASE_URL, TM8_AGENT_TOKEN and TM8_SPACE_ID set under `env -i`). The rig
// usually runs inside a tm8 session, whose env points at the live node, so
// every TM8_* var is STRIPPED from the child env: a wrapper that forgot `env -i`
// then fails instead of writing to the live node. The ambient `tm8` binary is
// refused outright.

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const resolve = (bin) => {
  try {
    const path = bin.includes('/') ? bin : execFileSync('/bin/sh', ['-c', `command -v "${bin}"`], { encoding: 'utf8' }).trim();
    return path ? realpathSync(path) : null;
  } catch {
    return null;
  }
};

export function devCli(name = 'TM8_CLI') {
  const cli = process.env[name];
  if (!cli) throw new Error(`set ${name} to a dev-node CLI wrapper (README step 3)`);
  const target = resolve(cli);
  if (!target) throw new Error(`${name}=${cli} does not resolve to an executable`);
  if (target === resolve('tm8')) throw new Error(`${name}=${cli} is the ambient tm8, which targets the live node; use the dev-node wrapper`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TM8_')));
  const run = (...args) => JSON.parse(execFileSync(cli, [...args, '--format', 'json'], { encoding: 'utf8', maxBuffer: 64 << 20, env }));
  run.path = cli;
  return run;
}
