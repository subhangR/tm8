/**
 * THE COMMAND REGISTRY — the one composition point.
 *
 * Every noun owns ONE file exporting its own `CommandModule[]`. This file is
 * the only place those arrays meet, and it is the only file a new domain slot's
 * work touches outside its own module. That shape exists for a specific
 * reason: eight further slots are landing domain commands in this package
 * concurrently, and a single inline array in `run.ts` would hand all eight the
 * same shared seam — the exact collision class that has already cost this
 * program a diagnostic cycle. One new file per slot, one import line here.
 *
 * DELIBERATELY STATIC. No plugin loader, no filesystem scanning, no
 * decorators. The closed-grammar property is load-bearing: the EBNF, the help
 * surface, and shell completion all depend on the command set being knowable
 * WITHOUT running anything, and auto-discovery would trade that away for
 * convenience nobody asked for.
 *
 * TWO REGISTRIES, TWO QUESTIONS. This file answers "what can this build
 * EXECUTE?". `src/discovery/operations.ts` answers "what does the GRAMMAR
 * contain?" — all 99 command paths, whether or not a handler exists yet. Both
 * answers are needed, because a documented command with no handler must say
 * "documented, not built here" (exit 8) rather than "unknown command" (exit 2).
 * `run.ts` consults them in that order; a test asserts every path registered
 * here is present in the projection, which is what catches a slot wiring a
 * command it forgot to document.
 */
import type { CommandModule } from '../run.js';
import { workerInit } from './worker-init.js';
import { completion } from './completion.js';
import { doctor } from './doctor.js';
import { help } from './help.js';
import { searchQuery } from './search.js';
import { KIND_COMMANDS } from './kind.js';
// Domain modules. One import + one spread each, added by the coordinator as each
// group reports its files landed — which is why no two domain slots ever share a
// line in this file. Order here is registration order only; it carries no meaning.
import { SPACE_COMMANDS } from './space.js';
import { IDENTITY_COMMANDS } from './identity.js';
import { AUTH_COMMANDS } from './auth.js';
import { EDGE_COMMANDS } from './edge.js';
import { COLLECTION_COMMANDS } from './collection.js';
import { PLACEMENT_COMMANDS } from './placement.js';
import { INBOX_COMMANDS } from './inbox.js';
import { SAVED_VIEW_COMMANDS } from './saved-view.js';
import { ACTION_COMMANDS } from './action.js';
import { EVENT_COMMANDS } from './event.js';
import { PRESENCE_COMMANDS } from './presence.js';
import { PROJECT_COMMANDS } from './project.js';
import { FILE_COMMANDS } from './file.js';
import { MESSAGE_COMMANDS } from './message.js';
import { HANDOFF_COMMANDS } from './handoff.js';
import { SESSION_COMMANDS } from './session.js';
import { SESSION_GIT_COMMANDS } from './session-git.js';
import { WORKTREE_GIT_COMMANDS } from './worktree-git.js';
import { INTERACTION_PROFILE_COMMANDS } from './interaction-profile.js';
import { PROFILE_DEFAULT_COMMANDS } from './teammate.js';
import { ENTITY_COMMANDS } from './entity.js';
import { ATTENTION_COMMANDS } from './attention.js';
import { TASK_COMMANDS } from './task.js';
import { TRACKING_COMMANDS } from './tracking.js';
import { GRAPH_COMMANDS } from './graph.js';
import { WORKTREE_COMMANDS } from './worktree.js';
import { UNDO_COMMANDS } from './undo.js';
import { SERVER_COMMANDS } from './server.js';
import { ARTIFACT_COMMANDS } from './artifact.js';
import { VOICE_COMMANDS } from './voice.js';

/**
 * Root discovery commands (§4.16). Not domain grammar: they take no Space, no
 * actor, and never reach the network, which is why they are listed here rather
 * than in a noun module.
 *
 * `doctor` joins them as the third LOCAL-ONLY command. It is not a catalog
 * operation and must never become one: it diagnoses the environment (PATH, the
 * database, db/migrations, git, the data dir) and makes exactly one diagnostic
 * probe at whichever node context resolved. It reaches the network only as the
 * SUBJECT of a check, never to perform an operation, so it takes no Space and
 * no actor exactly as `help` and `completion` do. Registering it here rather
 * than in `src/discovery/operations.ts` is deliberate: one catalog row costs a
 * frozen count pin, a pinned digest, a generated manifest and a
 * grammar-completeness guard, and `doctor` needs none of them.
 */
const DISCOVERY_COMMANDS: CommandModule[] = [
  { path: ['help'], run: (cmd) => help(cmd.args, cmd.options, cmd.out) },
  { path: ['completion'], run: (cmd) => completion(cmd.args, cmd.out) },
  { path: ['doctor'], run: (cmd) => doctor({ args: cmd.args, ctx: cmd.ctx, out: cmd.out }) },
];

/**
 * The harness bootstrap. Its CONTENT is owned by the harness slot; this file
 * owns only the registration, and treats `workerInit`'s exported shape as
 * fixed.
 */
const HARNESS_COMMANDS: CommandModule[] = [
  { path: ['worker', 'init'], run: (cmd) => workerInit(cmd.options, cmd.out) },
];

/** The reserved-but-discoverable half of the asymmetric pair (see ./search.ts). */
const SEARCH_COMMANDS: CommandModule[] = [
  { path: ['search', 'query'], run: (cmd) => searchQuery(cmd.args, cmd.out) },
];

export const COMMANDS: CommandModule[] = [
  ...DISCOVERY_COMMANDS,
  ...HARNESS_COMMANDS,
  ...SEARCH_COMMANDS,
  ...SERVER_COMMANDS,
  ...KIND_COMMANDS,
  ...SPACE_COMMANDS,
  ...IDENTITY_COMMANDS,
  ...AUTH_COMMANDS,
  ...EDGE_COMMANDS,
  ...COLLECTION_COMMANDS,
  ...PLACEMENT_COMMANDS,
  ...INBOX_COMMANDS,
  ...SAVED_VIEW_COMMANDS,
  ...ACTION_COMMANDS,
  ...EVENT_COMMANDS,
  ...PRESENCE_COMMANDS,
  ...PROJECT_COMMANDS,
  ...FILE_COMMANDS,
  ...MESSAGE_COMMANDS,
  ...HANDOFF_COMMANDS,
  ...SESSION_COMMANDS,
  ...SESSION_GIT_COMMANDS,
  ...WORKTREE_GIT_COMMANDS,
  ...INTERACTION_PROFILE_COMMANDS,
  ...PROFILE_DEFAULT_COMMANDS,
  ...ENTITY_COMMANDS,
  ...ATTENTION_COMMANDS,
  ...TASK_COMMANDS,
  ...TRACKING_COMMANDS,
  ...GRAPH_COMMANDS,
  ...WORKTREE_COMMANDS,
  ...UNDO_COMMANDS,
  ...ARTIFACT_COMMANDS,
  ...VOICE_COMMANDS,
];

const REGISTERED = new Map<string, CommandModule>(COMMANDS.map((c) => [c.path.join(' '), c]));

/* c8 ignore next 4 — a duplicate registration is a wiring bug, caught at import. */
if (REGISTERED.size !== COMMANDS.length) {
  const keys = COMMANDS.map((c) => c.path.join(' '));
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  throw new Error(`duplicate command registration: ${[...new Set(dupes)].join(', ')}`);
}

export function isRegisteredPath(path: readonly string[]): boolean {
  return REGISTERED.has(path.join(' '));
}

export function findCommand(path: readonly string[]): CommandModule | undefined {
  return REGISTERED.get(path.join(' '));
}
