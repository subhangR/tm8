/**
 * Node mode — Personal, Peer or Server (doc 14; plan and LLD doc 15 §3.1;
 * docs/identity/FIRST-RUN-CLAIM-DESIGN.md D4).
 *
 * TWO PLACES CAN HOLD IT, AND ONE OF THEM WINS.
 *
 *   1. `TM8_NODE_MODE` in the server's environment. When set it PINS the mode:
 *      an installer-managed Server writes it into `/etc/tm8/<slot>.env`, and
 *      `node.mode.set` refuses to move it.
 *   2. `<dataDir>/mode` — one word, 0600, next to `setup-token`. The first-run
 *      chooser and `tm8 node mode set` write it (`node.mode.set`).
 *
 * Neither set is the DEFAULT, which behaves as Personal — exactly what an unset
 * `TM8_NODE_MODE` (`single`) meant before modes existed, so an upgraded node
 * keeps the access it had. `single` and `multi` are accepted as aliases for
 * `personal` and `server` for one release; the boot banner flags them.
 *
 * READ AT BOOT, ONCE. The mode gates the loopback auto-owner arm, which is
 * resolved into `ServerConfig.disableAutoOwner` by `loadConfig`. A write to the
 * file changes nothing until the next restart, and `node.mode.set` says so.
 *
 * Why `TM8_NODE_MODE` and not `TM8_MODE`: `TM8_MODE` already carries the
 * SESSION mode into every spawned agent (`execution/src/spawn/manifest.ts`),
 * and `scripts/lib/env.mjs` passes it through, so a node reading it would take
 * its security posture from whatever its launcher's own session happened to be.
 */
import { chmod, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NodeModeView } from '@tm8/contract';

export const MODE_FILE = 'mode';
export const NODE_MODE_ENV = 'TM8_NODE_MODE';
export const NODE_MODES: readonly NodeModeView[] = ['personal', 'peer', 'server'];

/** The pre-modes spellings, honoured for one release. */
const ALIASES: Readonly<Record<string, NodeModeView>> = { single: 'personal', multi: 'server' };

export interface NormalizedNodeMode {
  readonly mode: NodeModeView;
  /** The raw value was `single` or `multi`: accepted, and the banner says so. */
  readonly deprecatedAlias: boolean;
}

/** A canonical word or a legacy alias, case-insensitive; null for anything else. */
export function normalizeNodeMode(raw: string): NormalizedNodeMode | null {
  const word = raw.trim().toLowerCase();
  if ((NODE_MODES as readonly string[]).includes(word)) {
    return { mode: word as NodeModeView, deprecatedAlias: false };
  }
  const alias = ALIASES[word];
  return alias ? { mode: alias, deprecatedAlias: true } : null;
}

/** A mode file that exists but cannot be used. `loadConfig` turns this into a boot refusal. */
export class NodeModeFileError extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
    this.name = 'NodeModeFileError';
  }
}

export function modeFilePath(dataDir: string): string {
  return join(dataDir, MODE_FILE);
}

/**
 * The recorded mode, or null when there is no file. ANY other outcome — an
 * unreadable file, or content that is not a mode — throws: a corrupt mode
 * file stops the boot exactly as a bad env value does, rather than falling
 * back to the permissive default.
 */
export function readModeFile(dataDir: string): NormalizedNodeMode | null {
  const path = modeFilePath(dataDir);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new NodeModeFileError(path, `cannot read ${path}: ${(err as Error).message}`);
  }
  const normalized = normalizeNodeMode(raw);
  if (!normalized) {
    throw new NodeModeFileError(
      path,
      `${path} must hold "personal", "peer" or "server", got ${JSON.stringify(raw.trim().slice(0, 40))}. `
        + `Fix or delete the file, or pin the mode with ${NODE_MODE_ENV}.`,
    );
  }
  return normalized;
}

/**
 * Record a mode. Written to a sibling and renamed over, so a crash mid-write
 * cannot leave a truncated file that the next boot would refuse. 0600 on open
 * AND an explicit chmod, because the open mode is masked by the umask (the
 * `setup-token` discipline). The chmod is best-effort where the platform has
 * no POSIX modes; its failure is returned for the caller to log.
 */
export async function writeModeFile(
  dataDir: string,
  mode: NodeModeView,
): Promise<{ path: string; chmodError: string | null }> {
  const path = modeFilePath(dataDir);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${mode}\n`, { mode: 0o600 });
  let chmodError: string | null = null;
  try {
    await chmod(tmp, 0o600);
  } catch (err) {
    chmodError = (err as Error).message;
  }
  await rename(tmp, path);
  return { path, chmodError };
}

/**
 * What a mode means for the running process. Peer is Personal plus an owner
 * password, so it keeps the loopback auto-owner arm: it is still the owner's
 * machine. Only Server turns the arm off.
 */
export function runtimeOf(mode: NodeModeView): { autoOwner: boolean } {
  return { autoOwner: mode !== 'server' };
}

/** Strictness order, for telling a tightening switch from a loosening one. */
export function modeRank(mode: NodeModeView): number {
  return NODE_MODES.indexOf(mode);
}
