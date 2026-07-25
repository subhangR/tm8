/**
 * Loads `@tm8/contract` — THE LAW — for the rigs.
 *
 * Deliberately NO vendored copy of the operation catalog. A test rig that keeps
 * its own path table is a second contract, and a second contract drifts; the
 * whole point of these rigs is to prove the ONE catalog is honoured. If the
 * contract package isn't built, we fail loudly with the command to build it
 * rather than quietly testing a stale table.
 *
 * Resolution order:
 *  1. `@tm8/contract` (present once the workspace is installed — the normal path)
 *  2. `../../../packages/contract/dist/index.js` (works with zero install, which
 *     is what lets these rigs run before anyone has run `bun install`)
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../../packages/contract/dist/index.js');

let cached = null;

export async function loadContract() {
  if (cached) return cached;
  const attempts = [];
  try {
    cached = await import('@tm8/contract');
    return cached;
  } catch (error) {
    attempts.push(`@tm8/contract → ${error.message}`);
  }
  try {
    cached = await import(pathToFileURL(DIST).href);
    return cached;
  } catch (error) {
    attempts.push(`${DIST} → ${error.message}`);
  }
  throw new Error(
    'tools/rigs: cannot load @tm8/contract. Build it first:\n' +
      '  bun run build:contract        (from the repo root)\n\n' +
      `attempts:\n  ${attempts.join('\n  ')}`,
  );
}

/**
 * `bindPath` bound to the loaded contract. Every rig request goes through this
 * — a rig may never hand-write a URL path, so a catalog rename breaks the rigs
 * at load time instead of producing a false RED against a route that moved.
 */
export async function operationPath(name, params = {}) {
  const contract = await loadContract();
  return contract.bindPath(name, params);
}

/** All v1 operations — used by the coverage report (which ops the rigs exercise). */
export async function v1Operations() {
  const contract = await loadContract();
  return contract.V1_OPERATIONS ?? contract.OPERATIONS.filter((op) => op.status === 'v1');
}
