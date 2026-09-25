// Where dev-node.sh records each eval node, and how the rig finds one by port.
// CTX_EVAL_HOME defaults to /private/tmp/ctxeval (a REAL path: skill paths
// refuse symlinks, and macOS /tmp is one).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const EVAL_HOME = process.env.CTX_EVAL_HOME ?? '/private/tmp/ctxeval';
export const ARMS = ['lean', 'index-derived', 'index-authored', 'inherit'];
export const ARM_ENV = {
  lean: { TM8_HARNESS_SURFACE: 'minimal' },
  'index-derived': { TM8_HARNESS_SURFACE: 'minimal', TM8_CONTEXT_INDEX: 'on' },
  'index-authored': { TM8_HARNESS_SURFACE: 'minimal', TM8_CONTEXT_INDEX: 'on' },
  inherit: { TM8_HARNESS_SURFACE: 'inherit' },
};

export function nodeRecord(port) {
  const file = join(EVAL_HOME, 'nodes', `${port}.json`);
  if (!existsSync(file)) throw new Error(`no eval node registered on port ${port} (${file}); run dev-node.sh up first`);
  const node = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['port', 'db', 'dataDir', 'buildDir', 'arm', 'cli', 'spaceId', 'projectId', 'repo']) {
    if (node[k] === undefined || node[k] === null) throw new Error(`${file}: missing ${k} (dev-node.sh up did not finish)`);
  }
  return node;
}
