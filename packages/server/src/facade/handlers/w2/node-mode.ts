/**
 * `node.mode.set` — switch this node between Personal, Peer and Server (doc 14
 * §5.2; plan and LLD doc 15 §2, §3.4).
 *
 * THE MODE IS CONFIG. This handler writes `<dataDir>/mode` and nothing else: the
 * running process keeps the mode it booted with (`deps.config` is never
 * mutated), because the mode gates the loopback auto-owner arm and that arm is
 * resolved once, in `loadConfig`. The answer says whether a restart moves it.
 *
 * THE CHECKS, IN THIS ORDER (doc 15 §2's table):
 *
 *  1. anonymous → `unauthenticated`. A remote caller and a loopback caller that
 *     came through a proxy (forwarding headers) are anonymous unless they hold
 *     a session: the auto-owner arm never fires for them.
 *  2. `TM8_NODE_MODE` set → `conflict` / `mode_pinned`. An installer-managed
 *     node is pinned by its env file and no operation may move it. The file's
 *     path is not in the answer: only the boot banner, on the box, names it.
 *  3. ANY target on an unclaimed node → `conflict` / `node_unclaimed`. Every
 *     mode, Personal included, needs the node claimed first (decision 34, the
 *     program lead's default C of 2026-09-26): with the launch cookie (#847) gating the
 *     auto-owner arm, a local agent is never the owner, so the owner proves
 *     themselves once with a password and the cookie replaces typing it. The
 *     first-run chooser therefore runs AFTER the claim. `node_is_claimed()`, so
 *     an existing password satisfies it. The op NEVER takes a password: the UI
 *     runs `auth.claim` first and calls this second, and a mode is never
 *     written ahead of a claim.
 *  4. the caller is not the owner → `forbidden` / `owner_session_required`.
 *     The owner is the loopback auto-owner arm, or a bearer session whose
 *     verified account is the owner and whose kind is `browser` or `cli` (an
 *     agent holding the owner's session is refused, fail-closed, as
 *     `requireHumanSession` does). LOOSENING — `server → *`, `peer → personal`
 *     — additionally refuses the auto-owner: in Peer and Server a loopback
 *     caller is not proof of being the owner, so only the owner's password
 *     (a bearer session) may widen who is trusted.
 *
 * "From" is the STRICTER of the running mode and the recorded file. A node
 * running Personal whose file already says Server (switched, not yet
 * restarted) is leaving Server, not Personal; judging from the running mode
 * alone would let the auto-owner undo a tightening before it took effect. An
 * unreadable or corrupt file counts as Server, the strictest reading.
 */
import { CollabError } from '@tm8/contract';
import type {
  NodeModeRefusalReason,
  NodeModeSetInput,
  NodeModeSetResult,
  NodeModeSourceView,
  NodeModeView,
} from '@tm8/contract';

import { resolveServerDataDir } from '../../../http/config.js';
import type { OperationHandler, RequestContext } from '../../../http/types.js';
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import { nodeIsClaimed, resolveBearerIdentity } from '../../../identity/pg-auth.js';
import {
  NODE_MODE_ENV,
  NodeModeFileError,
  modeRank,
  readModeFile,
  runtimeOf,
  writeModeFile,
} from '../../../identity/node-mode.js';

const OWNER_SESSION_KINDS: readonly string[] = ['browser', 'cli'];

function refuse(
  code: 'conflict' | 'forbidden',
  reason: NodeModeRefusalReason,
  message: string,
): CollabError {
  return new CollabError(code, message, { details: { reason } });
}

function stricter(a: NodeModeView, b: NodeModeView): NodeModeView {
  return modeRank(a) >= modeRank(b) ? a : b;
}

interface Recorded {
  /** The mode the file records, or null when there is no file or it cannot be used. */
  mode: NodeModeView | null;
  /** The file exists but cannot be used: a switch must overwrite it. */
  corrupt: boolean;
}

/** The recorded mode now (not at boot), read fresh on every call. */
function recordedMode(dataDir: string): Recorded {
  try {
    return { mode: readModeFile(dataDir)?.mode ?? null, corrupt: false };
  } catch (err) {
    if (err instanceof NodeModeFileError) return { mode: null, corrupt: true };
    throw err;
  }
}

/**
 * The mode as `auth.claim.status` reports it: the RECORDED mode, read now, not
 * the mode this process booted with.
 *
 * Why not the boot-time config (doc 15 §3.4 as written): a switch that needs no
 * restart — the first-run chooser's Personal, or personal ↔ peer — would keep
 * answering `modeSet: false` until the next boot, and the chooser would come
 * back on every reload of a node whose mode was already chosen. The file is
 * the answer the next boot will give, which is what every reader of the status
 * (the gate, Settings, `tm8 node mode`) is asking; `node.mode.set` says
 * separately whether a restart is needed to apply it.
 *
 * A pin is the env and is read from config. A file that cannot be used falls
 * back to the boot-time answer rather than failing a claim-free read.
 */
export function reportedNodeMode(config: FacadeDeps['config']): {
  mode: NodeModeView;
  modeSet: boolean;
  modeSource: NodeModeSourceView;
} {
  const booted = {
    mode: config.nodeMode ?? 'personal',
    modeSet: config.nodeModeSet ?? false,
    modeSource: config.nodeModeSource ?? 'default',
  } as const;
  if (booted.modeSource === 'env') return booted;
  const recorded = recordedMode(config.dataDir ?? resolveServerDataDir());
  if (recorded.corrupt) return booted;
  if (recorded.mode === null) return { mode: 'personal', modeSet: false, modeSource: 'default' };
  return { mode: recorded.mode, modeSet: true, modeSource: 'file' };
}

/** True when the caller is the owner's human bearer session. Never true for the auto-owner. */
async function isOwnerBearerSession(deps: FacadeDeps, ctx: RequestContext): Promise<boolean> {
  if (ctx.identity.kind !== 'bearer') return false;
  if (!ctx.identity.token) throw new CollabError('unauthenticated', 'bearer session is unresolved');
  const session = await resolveBearerIdentity(deps.db, ctx.identity.token);
  return session.isOwner && OWNER_SESSION_KINDS.includes(session.kind);
}

function nodeModeSet(deps: FacadeDeps): OperationHandler {
  return async (ctx) => {
    const { mode } = ctx.body as NodeModeSetInput;

    if (ctx.identity.kind === 'anonymous') {
      throw new CollabError('unauthenticated', 'authentication is required');
    }

    if (deps.config.nodeModeSource === 'env') {
      throw refuse(
        'conflict',
        'mode_pinned',
        `the node mode is pinned by ${NODE_MODE_ENV} in the Server's environment; `
          + 'change it there and restart the Server',
      );
    }

    if (!(await nodeIsClaimed(deps.db))) {
      throw refuse(
        'conflict',
        'node_unclaimed',
        'choosing a node mode needs an owner password: claim the node first (auth.claim), then choose',
      );
    }

    const dataDir = deps.config.dataDir ?? resolveServerDataDir();
    const running: NodeModeView = deps.config.nodeMode ?? 'personal';
    const recorded = recordedMode(dataDir);
    // A corrupt file is judged as Server, the strictest reading.
    const from = stricter(running, recorded.corrupt ? 'server' : recorded.mode ?? running);
    const loosening = modeRank(mode) < modeRank(from);

    const ownerBearer = await isOwnerBearerSession(deps, ctx);
    const admitted = ownerBearer || (ctx.identity.kind === 'auto-owner' && !loosening);
    if (!admitted) {
      throw refuse(
        'forbidden',
        'owner_session_required',
        loosening
          ? `leaving ${from === 'server' ? 'Server' : 'Peer'} needs the owner signed in with their password`
          : 'only the node owner may change the node mode',
      );
    }

    const previous: NodeModeView = recorded.mode ?? running;
    const restartRequired = runtimeOf(running).autoOwner !== runtimeOf(mode).autoOwner;
    // The same mode as recorded is a success with no write. A corrupt file is
    // always overwritten: left in place, it stops the next boot.
    if (recorded.corrupt || recorded.mode !== mode) {
      const { path, chmodError } = await writeModeFile(dataDir, mode);
      if (chmodError) console.warn(`[tm8] node mode: could not chmod 0600 ${path}: ${chmodError}`);
    }
    const result: NodeModeSetResult = { previous, mode, source: 'file', restartRequired };
    return result;
  };
}

export function registerW2NodeModeHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  registry.registerAll({
    'node.mode.set': nodeModeSet(deps),
  });
}
