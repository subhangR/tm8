/**
 * THE CONFIG REGISTRY — every knob that shapes tm8's behaviour, in one place.
 *
 * Settings → Configs renders whatever `spaces.configs` answers, and that
 * answer is built from this file alone. A new knob is one entry here; there is
 * no list in the UI to keep in step.
 *
 * Five families:
 *   - NODE_ENV    — read by the server process (server + execution run in it).
 *                   Node-admin only on the wire; a secret is presence-only.
 *   - CLI_ENV     — read by the `tm8` CLI in the caller's own shell. The server
 *                   cannot see those values, so it reports the definition only.
 *   - TEAMMATE_KNOBS — per-teammate launch settings: persona
 *                   `capabilities.launch.*` and the teammate row, under the node
 *                   env that outranks them.
 *   - PROFILE_KNOBS  — per-interaction-profile values, against the core default.
 *   - CODE_CONSTANTS — policy that only a code change moves. `read` imports the
 *                   real constant; it is never a copy.
 *
 * Every entry names its FILE (`definedIn`), never a line: `locate.ts` finds the
 * line from source, so an edit above a knob in a busy file cannot make this
 * registry stale. `test/configs/registry.test.ts` fails when a knob no longer
 * resolves to a line that names it. The same suite fails when a
 * `env.TM8_*` read appears in a package source without an entry here or on
 * `NOT_CONFIG_ENV` below.
 */
import {
  AUTHORED_HEADER_LIMITS,
  FILE_MAX_SIZE_BYTES_DEFAULT,
  HEADER_WHEN_TO_USE_BACKSTOP_CHARS,
  SPAWN_SELECTION_GROUP_LIMIT,
} from '@tm8/contract';
import type { ConfigChangeRoute } from '@tm8/contract';
import { DISPATCHER_ROSTER_READ_MAX, LANE_BUNDLED_SKILLS_OFF, LANE_SKILLS_ALWAYS_ON, MINIMAL_MCP_CONFIG } from '@tm8/execution';
import { ATTACHMENT_MANIFEST_MAX, BYTE_BUDGETS, INDEX_DERIVED_HEADER_CHARS, LINKED_MANIFEST_MAX } from '@tm8/prompt';

import { LINKED_ROW_CAP } from '../facade/execution-handlers.js';
import {
  CLIPBOARD_IMAGE_MIME_TYPES,
  CLIPBOARD_MAX_BYTES_DEFAULT,
  CLIPBOARD_RETENTION_DAYS_DEFAULT,
} from '../files/clipboard-store.js';
import { DEFAULT_AUTH_RATE_LIMITS, RATE_LIMITED_AUTH_OPS } from '../http/auth-rate-limit.js';
import { CANDIDATE_LIMIT, TEXT_LIMIT } from '../jev/candidates.js';
import { CRITICAL_SCORE, MEMORY_TICK_LIMIT, TEAMMATE_FIT_SCORE, TICK_SCORE } from '../jev/groups.js';

export interface EnvKnob {
  name: string;
  group: string;
  summary: string;
  /** Text of the value used when the variable is unset; `null` when there is none. */
  default: string | null;
  /** The defining file, from the repo root. The line is resolved from source (`locate.ts`). */
  definedIn: string;
  /** Credentials and keys: reported as present/absent, never as a value. */
  secret?: boolean;
}

export interface CodeConstant {
  name: string;
  group: string;
  summary: string;
  /** The defining file; the line is found by the constant's own declaration. */
  definedIn: string;
  /** The live value, imported from where it is defined. */
  read: () => unknown;
}

/** A per-subject knob: its value is resolved per teammate or per profile. */
export interface SubjectKnob {
  name: string;
  summary: string;
  default: string | null;
  /** The defining file. The line is found by the knob's last path segment unless `anchor` is given. */
  definedIn: string;
  /** An exact substring of the defining line, for a knob its own name cannot locate. */
  anchor?: string;
  change: ConfigChangeRoute;
  /**
   * What of the stored value may be shown. A value that can carry credentials
   * (an MCP server's headers or env) is reduced here, server-side, before it
   * is serialized.
   */
  display?: (value: unknown) => unknown;
}

const CONFIG = 'packages/server/src/http/config.ts';
const SIDECAR = 'packages/server/src/sidecar/config.ts';
const MANIFEST = 'packages/execution/src/spawn/manifest.ts';
const SPAWN = 'packages/execution/src/spawn/SpawnService.ts';
const EXEC_HANDLERS = 'packages/server/src/facade/execution-handlers.ts';
const MAIN = 'packages/server/src/main.ts';
const NODE_KEYS = 'packages/server/src/facade/services/w2/space-credential-catalog.ts';
const DOCTOR = 'packages/cli/src/commands/doctor.ts';

export const NODE_ENV: readonly EnvKnob[] = [
  // ── Network & access ──────────────────────────────────────────────────
  { name: 'TM8_ENV', group: 'Network & access', summary: 'dev or prod. Picks the default data directory and, in prod, requires an https public origin.', default: 'dev', definedIn: CONFIG },
  { name: 'TM8_BIND', group: 'Network & access', summary: 'Address the server binds. Loopback only; publish through a TLS reverse proxy.', default: '127.0.0.1', definedIn: CONFIG },
  { name: 'TM8_PORT', group: 'Network & access', summary: 'Port the server listens on.', default: '4610', definedIn: CONFIG },
  { name: 'TM8_PUBLIC_ORIGIN', group: 'Network & access', summary: 'Origin a browser reaches this node at, when it differs from the bind address. Used for the first-run claim link.', default: null, definedIn: CONFIG },
  { name: 'TM8_ALLOWED_HOSTNAMES', group: 'Network & access', summary: 'Extra Host header names accepted (comma-separated).', default: null, definedIn: CONFIG },
  { name: 'TM8_ALLOWED_ORIGINS', group: 'Network & access', summary: 'Extra browser origins accepted (comma-separated).', default: null, definedIn: CONFIG },
  { name: 'TM8_NODE_MODE', group: 'Network & access', summary: 'single: a loopback caller is the owner. multi: everyone signs in.', default: 'single', definedIn: CONFIG },
  { name: 'TM8_SPACE_SESSIONS', group: 'Network & access', summary: 'off | agents | enforce. agents pins agent tokens to their session\'s space (226/227); enforce behaves as agents until W3. Read once at boot.', default: 'agents', definedIn: CONFIG },
  { name: 'TM8_DISABLE_AUTO_OWNER', group: 'Network & access', summary: 'Turns off the loopback auto-owner arm. Implied by multi.', default: 'false', definedIn: CONFIG },
  { name: 'TM8_MAX_BODY_BYTES', group: 'Network & access', summary: 'Request body cap; larger bodies answer 413.', default: String(8 * 1024 * 1024), definedIn: CONFIG },
  { name: 'TM8_IDEMPOTENCY_ENABLED', group: 'Network & access', summary: 'Command-ledger replay and dedup. Off only for a local loop.', default: 'true', definedIn: CONFIG },
  { name: 'TM8_AUTH_MAX_ATTEMPTS', group: 'Network & access', summary: 'Auth attempts per client per window.', default: String(DEFAULT_AUTH_RATE_LIMITS.maxAttemptsPerClient), definedIn: CONFIG },
  { name: 'TM8_AUTH_ATTEMPT_WINDOW_MS', group: 'Network & access', summary: 'Window for the per-client auth attempt count.', default: String(DEFAULT_AUTH_RATE_LIMITS.attemptWindowMs), definedIn: CONFIG },
  { name: 'TM8_AUTH_MAX_FAILURES', group: 'Network & access', summary: 'Consecutive auth failures per principal before refusal.', default: String(DEFAULT_AUTH_RATE_LIMITS.maxFailuresPerPrincipal), definedIn: CONFIG },
  { name: 'TM8_AUTH_FAILURE_WINDOW_MS', group: 'Network & access', summary: 'Window for the per-principal failure count.', default: String(DEFAULT_AUTH_RATE_LIMITS.failureWindowMs), definedIn: CONFIG },
  { name: 'TM8_UI_DIR', group: 'Network & access', summary: 'Built web UI bundle served for non-/v2 paths. Unset in dev, where Vite serves the UI.', default: null, definedIn: CONFIG },

  // ── Storage & database ───────────────────────────────────────────────
  { name: 'TM8_DATABASE_URL', group: 'Storage & database', summary: 'Postgres connection string for the graph.', default: null, definedIn: CONFIG, secret: true },
  { name: 'TM8_DELIVERY_DATABASE_URL', group: 'Storage & database', summary: 'Separate Postgres connection for message delivery.', default: null, definedIn: MAIN, secret: true },
  { name: 'TM8_DB_POOL_MAX', group: 'Storage & database', summary: 'Postgres pool size — the node\'s read concurrency.', default: '8', definedIn: CONFIG },
  { name: 'TM8_DB_STATEMENT_TIMEOUT_MS', group: 'Storage & database', summary: 'Per-statement timeout.', default: '12000', definedIn: CONFIG },
  { name: 'TM8_DATA_DIR', group: 'Storage & database', summary: 'Server-owned state root.', default: '~/.tm8 (prod) or ~/.tm8-dev (dev)', definedIn: CONFIG },
  { name: 'TM8_FILE_MAX_SIZE_BYTES', group: 'Storage & database', summary: 'Per-blob ceiling for file grants, the file service and the blob store.', default: String(FILE_MAX_SIZE_BYTES_DEFAULT), definedIn: CONFIG },
  { name: 'TM8_CLIPBOARD_DIR', group: 'Storage & database', summary: 'Where pasted clipboard images land; exported to every agent.', default: '<data dir>/clipboard', definedIn: CONFIG },
  { name: 'TM8_CLIPBOARD_MAX_BYTES', group: 'Storage & database', summary: 'Per-image ceiling for a clipboard paste.', default: String(CLIPBOARD_MAX_BYTES_DEFAULT), definedIn: CONFIG },
  { name: 'TM8_CLIPBOARD_RETENTION_DAYS', group: 'Storage & database', summary: 'Days a clipboard bucket survives (0 = keep).', default: String(CLIPBOARD_RETENTION_DAYS_DEFAULT), definedIn: CONFIG },
  { name: 'TM8_PG_PORT', group: 'Storage & database', summary: 'Port of the bundled Postgres sidecar.', default: '5442', definedIn: SIDECAR },
  { name: 'TM8_PG_APP_ROLE', group: 'Storage & database', summary: 'Role the server connects as.', default: 'tm8_app', definedIn: SIDECAR },
  { name: 'TM8_PG_DATABASE', group: 'Storage & database', summary: 'Sidecar database name.', default: 'tm8', definedIn: SIDECAR },
  { name: 'TM8_PG_SUPERUSER', group: 'Storage & database', summary: 'Sidecar superuser (migrations).', default: 'tm8', definedIn: SIDECAR },
  { name: 'TM8_REPO_ROOT', group: 'Storage & database', summary: 'Checkout the sidecar reads migrations from.', default: 'the running checkout', definedIn: SIDECAR },
  { name: 'TM8_PG_BIN_DIR', group: 'Storage & database', summary: 'Postgres binaries the sidecar runs.', default: 'discovered on PATH', definedIn: SIDECAR },
  { name: 'TM8_PG_LOCALE_PROVIDER', group: 'Storage & database', summary: 'initdb locale provider.', default: 'builtin', definedIn: 'packages/server/src/sidecar/cluster.ts' },
  { name: 'TM8_PG_LOCALE', group: 'Storage & database', summary: 'initdb locale.', default: 'C.UTF-8', definedIn: 'packages/server/src/sidecar/cluster.ts' },
  { name: 'TM8_PG_ENCODING', group: 'Storage & database', summary: 'initdb encoding.', default: 'UTF8', definedIn: 'packages/server/src/sidecar/cluster.ts' },
  { name: 'TM8_LOG_LEVEL', group: 'Storage & database', summary: 'Sidecar log level: error, warn, info or debug.', default: 'info', definedIn: 'packages/server/src/sidecar/log.ts' },

  // ── Lane launch ──────────────────────────────────────────────────────
  { name: 'TM8_AGENT_CMD', group: 'Lane launch', summary: 'Replaces the agent binary for every lane (an operator wrapper).', default: null, definedIn: MANIFEST, secret: true },
  { name: 'TM8_HARNESS_SURFACE', group: 'Lane launch', summary: 'minimal or inherit for every Claude lane. Outranks the persona setting.', default: 'minimal', definedIn: MANIFEST },
  { name: 'TM8_READ_HINTS', group: 'Lane launch', summary: 'Installs the large-read hint hook on every Claude lane. Outranks the persona setting.', default: 'off', definedIn: MANIFEST },
  { name: 'TM8_CONTEXT_INDEX', group: 'Lane launch', summary: 'on or off for every launch: <context_index> (skills, references, teammates with headers, trimmed per group) in place of <skills>; a dispatcher\'s teammates group is the space roster. Outranks the profile contextIndex. Shipped dark.', default: 'unset (profile decides; off)', definedIn: 'packages/execution/src/spawn/context-index.ts' },
  { name: 'TM8_PERMISSION_MODE', group: 'Lane launch', summary: 'Permission mode for every lane that does not request an access mode. Outranks the persona.', default: 'auto', definedIn: MANIFEST },
  { name: 'TM8_REQUIRE_CODEX_SANDBOX', group: 'Lane launch', summary: 'Refuses a Codex lane whose sandbox cannot be verified (1).', default: 'off', definedIn: SPAWN },
  { name: 'TM8_AUTO_TRUST_WORKSPACE', group: 'Lane launch', summary: 'Pre-trusts a lane\'s worktree in the agent config so it starts without a trust prompt (false turns it off).', default: 'true', definedIn: 'packages/execution/src/spawn/workspace-trust.ts' },
  { name: 'TM8_SESSION_CAP', group: 'Lane launch', summary: 'Concurrent agent sessions this node runs.', default: '64', definedIn: EXEC_HANDLERS },
  { name: 'TM8_TERMINAL_CAP', group: 'Lane launch', summary: 'Concurrent human terminals this node runs.', default: '4', definedIn: EXEC_HANDLERS },
  { name: 'TM8_WORKTREE_CAP', group: 'Lane launch', summary: 'Concurrent worktree lanes (0 = unlimited).', default: '0', definedIn: EXEC_HANDLERS },
  { name: 'TM8_LAUNCH_BOOTSTRAP', group: 'Lane launch', summary: 'Seeds launchable personas and the current project at boot (0 turns it off).', default: 'on', definedIn: CONFIG },
  { name: 'TM8_PROJECT_DIR', group: 'Lane launch', summary: 'Project the launch bootstrap registers.', default: 'the server\'s working directory', definedIn: CONFIG },
  { name: 'TM8_PROJECT_ROOTS', group: 'Lane launch', summary: 'Directories offered when linking a project.', default: null, definedIn: 'packages/server/src/facade/services/w2/project-directories.ts' },
  { name: 'CLAUDE_CONFIG_DIR', group: 'Lane launch', summary: 'Claude Code config home a lane uses when no credential home is chosen.', default: '~/.claude', definedIn: SPAWN },
  { name: 'CODEX_HOME', group: 'Lane launch', summary: 'Codex config home a lane uses when no credential home is chosen; also scanned for skills.', default: '~/.codex', definedIn: SPAWN },
  { name: 'HERMES_HOME', group: 'Lane launch', summary: 'Hermes home scanned for skills.', default: null, definedIn: 'packages/server/src/skills/service.ts' },
  { name: 'CLAUDE_MANAGED_SETTINGS_DIR', group: 'Lane launch', summary: 'Claude Code managed-settings directory scanned for skills.', default: '/etc/claude-code', definedIn: 'packages/server/src/skills/service.ts' },
  { name: 'TM8_CHAT_SKILLS_DIR', group: 'Lane launch', summary: 'Skills plugin directory chat threads load.', default: null, definedIn: MAIN },

  // ── Containers ───────────────────────────────────────────────────────
  { name: 'TM8_CONTAINERS', group: 'Containers', summary: 'Container runtime gate (off disables it).', default: 'on', definedIn: CONFIG },
  { name: 'TM8_CONTAINER_DATA_DIR', group: 'Containers', summary: 'Container state directory.', default: '<data dir>/containers', definedIn: CONFIG },
  { name: 'TM8_CONTAINER_PROVIDERS', group: 'Containers', summary: 'Enabled container providers.', default: 'docker,gvisor,android-emulator', definedIn: CONFIG },
  { name: 'TM8_CONTAINER_CAP', group: 'Containers', summary: 'Concurrent containers.', default: '4', definedIn: CONFIG },
  { name: 'TM8_CONTAINER_EXEC_CAP', group: 'Containers', summary: 'Concurrent container execs.', default: '8', definedIn: CONFIG },
  { name: 'TM8_CONTAINER_IMAGE_REGISTRY', group: 'Containers', summary: 'Registry container images are pulled from.', default: 'ghcr.io/subhangr/tm8', definedIn: CONFIG, secret: true },
  { name: 'TM8_CONTAINER_KEEP_FAILED', group: 'Containers', summary: 'Keeps failed containers for inspection.', default: 'false', definedIn: CONFIG },

  // ── Previews & voice ─────────────────────────────────────────────────
  { name: 'TM8_PREVIEW_ENABLED', group: 'Previews & voice', summary: 'Artifact preview server.', default: 'true', definedIn: CONFIG },
  { name: 'TM8_PREVIEW_FRAME_ANCESTORS', group: 'Previews & voice', summary: 'Extra origins allowed to frame previews.', default: null, definedIn: CONFIG },
  { name: 'TM8_PREVIEW_HOST', group: 'Previews & voice', summary: 'Preview server bind host.', default: 'derived from TM8_BIND', definedIn: CONFIG },
  { name: 'TM8_PREVIEW_PORT', group: 'Previews & voice', summary: 'Preview server port.', default: 'derived from TM8_PORT', definedIn: CONFIG },
  { name: 'TM8_PREVIEW_PUBLIC_ORIGIN', group: 'Previews & voice', summary: 'Origin browsers load previews from.', default: null, definedIn: CONFIG },
  { name: 'TM8_LIVEKIT_URL', group: 'Previews & voice', summary: 'LiveKit server for voice.', default: null, definedIn: CONFIG },
  { name: 'TM8_LIVEKIT_API_KEY', group: 'Previews & voice', summary: 'LiveKit API key.', default: null, definedIn: CONFIG, secret: true },
  { name: 'TM8_LIVEKIT_API_SECRET', group: 'Previews & voice', summary: 'LiveKit API secret.', default: null, definedIn: CONFIG, secret: true },

  // ── Keys ─────────────────────────────────────────────────────────────
  { name: 'TYPESAFE_API_KEY', group: 'Keys', summary: 'Node key for Jev (TypeSafe), used when a member has none.', default: null, definedIn: MAIN, secret: true },
  { name: 'ANTHROPIC_API_KEY', group: 'Keys', summary: 'Node fallback Anthropic key for launches.', default: null, definedIn: NODE_KEYS, secret: true },
  { name: 'OPENAI_API_KEY', group: 'Keys', summary: 'Node fallback OpenAI key for launches.', default: null, definedIn: NODE_KEYS, secret: true },
  { name: 'GH_TOKEN', group: 'Keys', summary: 'Node fallback GitHub token (launches and PR tracking).', default: null, definedIn: NODE_KEYS, secret: true },
  { name: 'GITHUB_TOKEN', group: 'Keys', summary: 'Alternative name for the node GitHub token.', default: null, definedIn: NODE_KEYS, secret: true },
  { name: 'TM8_GITHUB_TOKEN', group: 'Keys', summary: 'GitHub token PR tracking prefers over GITHUB_TOKEN / GH_TOKEN.', default: null, definedIn: 'packages/server/src/tracking/github.ts', secret: true },
];

export const CLI_ENV: readonly EnvKnob[] = [
  { name: 'TM8_BASE_URL', group: 'CLI', summary: 'Server the tm8 CLI talks to.', default: 'http://127.0.0.1:4610', definedIn: 'packages/cli/src/env.ts' },
  { name: 'TM8_CONFIG_PATH', group: 'CLI', summary: 'CLI config file.', default: '$XDG_CONFIG_HOME/tm8/config.json', definedIn: 'packages/cli/src/context.ts' },
  { name: 'TM8_CREDENTIALS_PATH', group: 'CLI', summary: 'CLI credentials file (forces the file store).', default: '$XDG_CONFIG_HOME/tm8/credentials.json', definedIn: 'packages/cli/src/credentials.ts' },
  { name: 'TM8_CREDENTIALS_MODE', group: 'CLI', summary: 'CLI credential store: keychain or file.', default: 'platform default', definedIn: 'packages/cli/src/credentials.ts' },
  { name: 'TM8_NO_CACHE', group: 'CLI', summary: 'Turns off the lane read cache.', default: null, definedIn: 'packages/cli/src/read-cache.ts' },
  { name: 'TM8_NO_RECEIPTS', group: 'CLI', summary: 'Turns off write receipts (1).', default: null, definedIn: 'packages/cli/src/receipt.ts' },
  { name: 'TM8_NO_TERSE_DEFAULT', group: 'CLI', summary: 'Full output instead of the terse default (1).', default: null, definedIn: 'packages/cli/src/args.ts' },
  { name: 'TM8_JOURNAL_CLASS', group: 'CLI', summary: 'Overrides the journal\'s agent class.', default: 'detected', definedIn: 'packages/cli/src/journal-stats.ts' },
  { name: 'TM8_GITHUB_API_BASE', group: 'CLI', summary: 'GitHub API base for tm8 task link-pr.', default: 'https://api.github.com', definedIn: 'packages/cli/src/commands/task.ts' },
  { name: 'DATABASE_URL', group: 'CLI', summary: 'tm8 doctor database, when TM8_DATABASE_URL is unset.', default: null, definedIn: DOCTOR, secret: true },
  { name: 'TM8_PG_HOST', group: 'CLI', summary: 'tm8 doctor Postgres host.', default: '127.0.0.1', definedIn: DOCTOR },
  { name: 'TM8_PG_USER', group: 'CLI', summary: 'tm8 doctor Postgres user.', default: '$USER', definedIn: DOCTOR },
  { name: 'TM8_DB', group: 'CLI', summary: 'tm8 doctor database name.', default: 'tm8_dev', definedIn: DOCTOR },
  { name: 'TM8_PG_MAJOR', group: 'CLI', summary: 'tm8 doctor expected Postgres major.', default: null, definedIn: DOCTOR },
  { name: 'TM8_PSQL', group: 'CLI', summary: 'tm8 doctor psql binary.', default: 'psql on PATH', definedIn: DOCTOR },
  { name: 'TM8_MIGRATIONS_DIR', group: 'CLI', summary: 'tm8 doctor migrations directory.', default: '<repo>/db/migrations', definedIn: DOCTOR },
];

/**
 * Env names tm8 reads that are NOT configuration: tm8 sets them itself on a
 * spawned session (identity, paths, tokens), or they are the OS's own. The
 * completeness test accepts a read of one of these without a registry entry.
 */
export const NOT_CONFIG_ENV: Readonly<Record<string, string>> = {
  TM8_SESSION_ID: 'set by tm8 on each spawned session',
  TM8_AGENT_TOKEN: 'set by tm8 on each spawned session',
  TM8_AGENT_RUNTIME_TOKEN: 'set by tm8 on each chat thread',
  TM8_TEAM_MEMBER_ID: 'set by tm8 on each spawned session',
  TM8_SPACE_ID: 'set by tm8 on each spawned session',
  TM8_ACTOR_ID: 'set by tm8 on each spawned session',
  TM8_MANIFEST_PATH: 'set by tm8 on each spawned session',
  TM8_JOURNAL_PATH: 'set by tm8 on each spawned session',
  TM8_PROJECT_ID: 'set by tm8 on each spawned session',
  TM8_MODEL: 'set by tm8 on each spawned session',
  TM8_GIT_LOGIN: 'set by tm8 on each spawned session',
  TM8_CHAT_MODE: 'set by tm8 on each chat thread',
};

/**
 * The files whose exported UPPER_CASE constants are behaviour policy. The
 * registry test fails when one of them exports a constant that is neither in
 * `CODE_CONSTANTS` nor in `NOT_POLICY_CONSTANTS` with a reason — so a new
 * policy constant cannot ship without appearing on the Configs page. A new
 * policy file is one line here.
 */
export const POLICY_FILES: readonly string[] = [
  'packages/prompt/src/budgets.ts',
  'packages/prompt/src/templates.ts',
  'packages/execution/src/spawn/harness-surface.ts',
  'packages/server/src/jev/groups.ts',
  'packages/server/src/jev/candidates.ts',
  'packages/server/src/http/auth-rate-limit.ts',
  'packages/server/src/files/clipboard-store.ts',
];

/** Exported constants in `POLICY_FILES` that are vocabulary or plumbing, not a knob. */
export const NOT_POLICY_CONSTANTS: Readonly<Record<string, string>> = {
  HARNESS_SURFACES: 'the closed vocabulary of harnessSurface values, not a setting',
  CHROME_RECORD_NAME: 'the label launch.harness records --no-chrome under, not a setting',
  TRUSTED_CONTROL_TYPES: 'the closed vocabulary of control envelope types',
  DISCOVERY_PROMPT_FORM: 'prompt wording, shown on the Prompts page',
  COORDINATOR_KINDS: 'the closed vocabulary of coordinator anchors',
  ZERO_COST: 'the zero value of Jev cost accounting',
};

export const CODE_CONSTANTS: readonly CodeConstant[] = [
  { name: 'BYTE_BUDGETS', group: 'Prompt budgets', summary: 'Byte budgets. The hard ceilings (manifest, kernel, assignmentSnapshot, combinedInitialInjection, handoffEnvelope, incomingMessageInjection) are never larger on any profile. The context sub-caps (memoryInjection, referenceIndex, rosterIndex) are node defaults a profile may reallocate, up or down, through contextBudgets.* within combinedInitialInjection: warned at profile save when they cannot fit; the prompt is trimmed to the ceiling at launch.', definedIn: 'packages/prompt/src/budgets.ts', read: () => BYTE_BUDGETS },
  { name: 'INDEX_DERIVED_HEADER_CHARS', group: 'Prompt budgets', summary: 'Characters a DERIVED summary keeps in the <context_index> (the entry declares the cut in clipped="…"). A whenToUse is never cut there, whatever its source; authored and native text is never cut there; Jev keeps its own 600. Under budget pressure a summary is also the first thing the index drops (dropped="summary"), before any whole entry.', definedIn: 'packages/prompt/src/context-index.ts', read: () => INDEX_DERIVED_HEADER_CHARS },
  { name: 'HEADER_WHEN_TO_USE_BACKSTOP_CHARS', group: 'Jev selection', summary: 'The only cut a selection header\'s whenToUse ever gets, of any source, in every reader (the <context_index>, Jev\'s candidate text, entity get/context): a backstop against a pathological header, declared in clipped. Below it a whenToUse is shown whole; past the 400-character guidance the write warns header_long.', definedIn: 'packages/contract/src/selection-header.ts', read: () => HEADER_WHEN_TO_USE_BACKSTOP_CHARS },
  { name: 'LINKED_MANIFEST_MAX', group: 'Prompt budgets', summary: 'Linked entities listed in a launch prompt.', definedIn: 'packages/prompt/src/templates.ts', read: () => LINKED_MANIFEST_MAX },
  { name: 'ATTACHMENT_MANIFEST_MAX', group: 'Prompt budgets', summary: 'Attached files listed in a prompt; the rest are declared omitted.', definedIn: 'packages/prompt/src/templates.ts', read: () => ATTACHMENT_MANIFEST_MAX },
  { name: 'LINKED_ROW_CAP', group: 'Prompt budgets', summary: 'Linked rows read for a launch before the prompt picks its subset.', definedIn: EXEC_HANDLERS, read: () => LINKED_ROW_CAP },
  { name: 'DISPATCHER_ROSTER_READ_MAX', group: 'Prompt budgets', summary: 'Teammates a dispatcher\'s <context_index> roster reads (context index on). The rest are declared in the teammates group\'s omitted count; rosterIndex then trims what was read.', definedIn: 'packages/execution/src/spawn/context-index.ts', read: () => DISPATCHER_ROSTER_READ_MAX },
  { name: 'TEAMMATE_FIT_SCORE', group: 'Jev selection', summary: 'A teammate scoring at least this "fits" the work.', definedIn: 'packages/server/src/jev/groups.ts', read: () => TEAMMATE_FIT_SCORE },
  { name: 'TICK_SCORE', group: 'Jev selection', summary: 'A memory or skill at or above this is pre-ticked.', definedIn: 'packages/server/src/jev/groups.ts', read: () => TICK_SCORE },
  { name: 'CRITICAL_SCORE', group: 'Jev selection', summary: 'A row at or above this is always ticked.', definedIn: 'packages/server/src/jev/groups.ts', read: () => CRITICAL_SCORE },
  { name: 'MEMORY_TICK_LIMIT', group: 'Jev selection', summary: 'Most memories Ask Jev pre-ticks. The spawn ceiling is SPAWN_SELECTION_GROUP_LIMIT.', definedIn: 'packages/server/src/jev/groups.ts', read: () => MEMORY_TICK_LIMIT },
  { name: 'CANDIDATE_LIMIT', group: 'Jev selection', summary: 'Candidates Jev ranks per group per launch. Defined from SPAWN_SELECTION_GROUP_LIMIT.', definedIn: 'packages/server/src/jev/candidates.ts', read: () => CANDIDATE_LIMIT },
  { name: 'SPAWN_SELECTION_GROUP_LIMIT', group: 'Jev selection', summary: 'Most ids one spawn selection group (memories, skills, references) may name. A safety ceiling equal to the candidate pool; the byte budget is the real limit.', definedIn: 'packages/contract/src/contract.ts', read: () => SPAWN_SELECTION_GROUP_LIMIT },
  { name: 'TEXT_LIMIT', group: 'Jev selection', summary: 'Characters of a memory, persona or skill description that may leave the server.', definedIn: 'packages/server/src/jev/candidates.ts', read: () => TEXT_LIMIT },
  { name: 'AUTHORED_HEADER_LIMITS', group: 'Jev selection', summary: 'Authored selection-header GUIDANCE (characters): whenToUse, summary, keyword count and length. Nothing refuses a longer header (migration 223). A longer whenToUse is shown whole (HEADER_WHEN_TO_USE_BACKSTOP_CHARS bounds it) and its write warns header_long; every reader clips the summary and keywords to these numbers and declares it in `clipped`.', definedIn: 'packages/contract/src/selection-header.ts', read: () => AUTHORED_HEADER_LIMITS },
  { name: 'LANE_BUNDLED_SKILLS_OFF', group: 'Lane launch', summary: 'Bundled Claude Code skills a minimal lane turns off (skillOverrides). Kept: code-review, simplify, security-review, workflow-authoring. Escape: persona harnessSurface inherit, or TM8_HARNESS_SURFACE=inherit.', definedIn: 'packages/execution/src/spawn/harness-surface.ts', read: () => LANE_BUNDLED_SKILLS_OFF },
  { name: 'LANE_SKILLS_ALWAYS_ON', group: 'Lane launch', summary: 'Skills a minimal lane always keeps fully listed. Every other operator skill (~/.claude/skills, claude.ai-synced) the launch did not equip is turned off with skillOverrides; an equipped native one goes name-only. Escape: persona harnessSurface inherit, or TM8_HARNESS_SURFACE=inherit.', definedIn: 'packages/execution/src/spawn/harness-surface.ts', read: () => LANE_SKILLS_ALWAYS_ON },
  { name: 'MINIMAL_MCP_CONFIG', group: 'Lane launch', summary: 'MCP config a minimal lane runs under --strict-mcp-config.', definedIn: 'packages/execution/src/spawn/harness-surface.ts', read: () => MINIMAL_MCP_CONFIG },
  { name: 'DEFAULT_AUTH_RATE_LIMITS', group: 'Network & access', summary: 'Auth rate limits used when the TM8_AUTH_* variables are unset.', definedIn: 'packages/server/src/http/auth-rate-limit.ts', read: () => DEFAULT_AUTH_RATE_LIMITS },
  { name: 'RATE_LIMITED_AUTH_OPS', group: 'Network & access', summary: 'Operations the auth rate limits apply to.', definedIn: 'packages/server/src/http/auth-rate-limit.ts', read: () => [...RATE_LIMITED_AUTH_OPS] },
  { name: 'CLIPBOARD_IMAGE_MIME_TYPES', group: 'Storage & database', summary: 'Image types a clipboard paste accepts.', definedIn: 'packages/server/src/files/clipboard-store.ts', read: () => [...CLIPBOARD_IMAGE_MIME_TYPES] },
  { name: 'FILE_MAX_SIZE_BYTES_DEFAULT', group: 'Storage & database', summary: 'Per-blob ceiling when TM8_FILE_MAX_SIZE_BYTES is unset.', definedIn: 'packages/contract/src/contract.ts', read: () => FILE_MAX_SIZE_BYTES_DEFAULT },
  { name: 'CLIPBOARD_MAX_BYTES_DEFAULT', group: 'Storage & database', summary: 'Clipboard image ceiling when TM8_CLIPBOARD_MAX_BYTES is unset.', definedIn: 'packages/server/src/files/clipboard-store.ts', read: () => CLIPBOARD_MAX_BYTES_DEFAULT },
  { name: 'CLIPBOARD_RETENTION_DAYS_DEFAULT', group: 'Storage & database', summary: 'Clipboard retention when TM8_CLIPBOARD_RETENTION_DAYS is unset.', definedIn: 'packages/server/src/files/clipboard-store.ts', read: () => CLIPBOARD_RETENTION_DAYS_DEFAULT },
];

/**
 * Per-teammate launch settings. The `capabilities.launch.*` rows are the
 * persona's launch bag, parsed by the same `memberLaunchPreferences` the spawn
 * path uses — the registry test fails when that function returns a key with no
 * row here. The rest are the teammate row. Node env named in `envName`
 * outranks the persona, exactly as `resolveLaunchConfig` does.
 */
export const TEAMMATE_KNOBS: readonly (SubjectKnob & { envName?: string })[] = [
  { name: 'capabilities.launch.harnessSurface', summary: 'Harness surface a Claude lane boots with.', default: 'minimal', definedIn: MANIFEST, anchor: 'function memberLaunchPreferences', change: 'persona', envName: 'TM8_HARNESS_SURFACE' },
  { name: 'capabilities.launch.plugins', summary: 'Plugins a minimal lane keeps. Plugins with skill entities belong in equips instead (scripts/migrate-launch-plugins-to-equips.mjs, human-run).', default: 'none', definedIn: MANIFEST, anchor: 'function memberLaunchPreferences', change: 'persona' },
  { name: 'capabilities.launch.mcpServers', summary: 'MCP servers a minimal lane loads (--mcp-config under --strict-mcp-config). Server names only; their configs can hold credentials.', default: 'none', definedIn: MANIFEST, anchor: 'function memberLaunchPreferences', change: 'persona', display: (v) => (v && typeof v === 'object' ? Object.keys(v as object) : v) },
  { name: 'capabilities.launch.readHints', summary: 'Large-read hint hook on a Claude lane.', default: 'false', definedIn: MANIFEST, anchor: 'function memberLaunchPreferences', change: 'persona', envName: 'TM8_READ_HINTS' },
  { name: 'agent_tool', summary: 'Agent harness the teammate launches.', default: null, definedIn: EXEC_HANDLERS, anchor: 'tm.agent_tool', change: 'persona' },
  { name: 'model', summary: 'Model the teammate launches with.', default: null, definedIn: EXEC_HANDLERS, anchor: 'tm.model', change: 'persona' },
  { name: 'permission_mode', summary: 'Permission mode when the launch requests no access mode.', default: 'auto', definedIn: EXEC_HANDLERS, anchor: 'tm.permission_mode', change: 'persona', envName: 'TM8_PERMISSION_MODE' },
];

const CORE_DRAFT = 'db/migrations/079_core_draft_prompt_policy_repair.sql';

/** Interaction-profile values, by JSON path into the draft, against the core default. */
export const PROFILE_KNOBS: readonly SubjectKnob[] = [
  { name: 'promptPolicy.kernelTemplate', summary: 'Kernel prompt template sessions on this profile get.', default: 'tm8.core.v1', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'promptPolicy.manifestMaxBytes', summary: 'Launch manifest byte ceiling (≤ BYTE_BUDGETS.manifest).', default: '4096', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'promptPolicy.kernelMaxBytes', summary: 'Kernel prompt byte ceiling (≤ BYTE_BUDGETS.kernel).', default: '6144', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'promptPolicy.initialContextMaxBytes', summary: 'Initial context byte ceiling.', default: '32768', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'promptPolicy.rollingControlMaxBytes', summary: 'Rolling control message byte ceiling.', default: '32768', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'toolDiscoveryPolicy.semanticSearchEnabled', summary: 'Semantic help search on or off.', default: 'true', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'toolDiscoveryPolicy.semanticMaxMatches', summary: 'Matches a semantic help search returns.', default: '5', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'toolDiscoveryPolicy.nounShardMaxBytes', summary: 'Byte ceiling of one noun help shard.', default: '8192', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'toolDiscoveryPolicy.commandShardMaxBytes', summary: 'Byte ceiling of one command help shard.', default: '16384', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'toolDiscoveryPolicy.entityContextDefaultBytes', summary: 'Default byte budget of entity context.', default: '16384', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'feedPolicy.pageSize', summary: 'Chat feed page size.', default: '50', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'feedPolicy.bodyExcerptBytes', summary: 'Chat feed body excerpt bytes.', default: '1024', definedIn: CORE_DRAFT, change: 'profile' },
  { name: 'contextIndex', summary: 'Sessions on this profile render <context_index> in place of <skills>. TM8_CONTEXT_INDEX outranks it.', default: 'false', definedIn: 'packages/contract/src/contract.ts', anchor: 'contextIndex?: boolean;', change: 'profile' },
  { name: 'contextBudgets.memories', summary: 'Bytes of memories injected whole; past it the lowest-ranked collapse into <context_index>. Warned at save if the budgets cannot fit the prompt; the prompt is trimmed to the ceiling at launch.', default: '12288 (BYTE_BUDGETS.memoryInjection)', definedIn: 'packages/contract/src/context-budgets.ts', anchor: 'contextBudgets.memories', change: 'profile' },
  { name: 'contextBudgets.skills', summary: 'Bytes of <context_index> skill entries; unset, skills take what the prompt has left. Warned at save if the budgets cannot fit the prompt; the prompt is trimmed to the ceiling at launch.', default: 'what remains', definedIn: 'packages/contract/src/context-budgets.ts', anchor: 'contextBudgets.skills', change: 'profile' },
  { name: 'contextBudgets.references', summary: 'Bytes of <context_index> reference entries (a worker\'s linked teammates share it unless teammates is set). Warned at save if the budgets cannot fit the prompt; the prompt is trimmed to the ceiling at launch.', default: '8192 (BYTE_BUDGETS.referenceIndex)', definedIn: 'packages/contract/src/context-budgets.ts', anchor: 'contextBudgets.references', change: 'profile' },
  { name: 'contextBudgets.teammates', summary: 'Bytes of <context_index> teammate entries. Warned at save if the budgets cannot fit the prompt; the prompt is trimmed to the ceiling at launch.', default: 'shares references (worker); 8192 (BYTE_BUDGETS.rosterIndex, dispatcher)', definedIn: 'packages/contract/src/context-budgets.ts', anchor: 'contextBudgets.teammates', change: 'profile' },
  { name: 'contextFloors.memories', summary: 'Jev score floor for filling the memories budget; lower-scored items never fill leftover space. Applied by Ask Jev, not spawn.', default: '1.5', definedIn: 'packages/contract/src/context-budgets.ts', anchor: 'contextFloors.memories', change: 'profile' },
  { name: 'contextFloors.skills', summary: 'Jev score floor for filling the skills budget; lower-scored items never fill leftover space. Applied by Ask Jev, not spawn.', default: '1.5', definedIn: 'packages/contract/src/context-budgets.ts', anchor: 'contextFloors.skills', change: 'profile' },
  { name: 'contextFloors.references', summary: 'Jev score floor for filling the references budget; lower-scored items never fill leftover space. Applied by Ask Jev, not spawn.', default: '1.5', definedIn: 'packages/contract/src/context-budgets.ts', anchor: 'contextFloors.references', change: 'profile' },
  { name: 'contextFloors.teammates', summary: 'Jev score floor for filling the teammates budget; lower-scored items never fill leftover space. Applied by Ask Jev, not spawn.', default: '1.0', definedIn: 'packages/contract/src/context-budgets.ts', anchor: 'contextFloors.teammates', change: 'profile' },
  { name: 'initialContentSurface', summary: 'Surface a session on this profile opens on: terminal or chat. Unset defers to the pinned template.', default: null, definedIn: 'packages/contract/src/contract.ts', anchor: "initialContentSurface?: 'terminal' | 'chat';", change: 'profile' },
];

/**
 * Leaves of `InteractionProfileDraftSchema` that are not a knob. The registry
 * test walks the schema and fails on any leaf path that is neither a
 * `PROFILE_KNOBS` row nor listed here — so a new profile field (a budget, a
 * floor) cannot ship without a row on the Configs page.
 */
export const NOT_PROFILE_KNOBS: Readonly<Record<string, string>> = {
  name: 'the profile\'s label, shown as the subject heading',
  templateKey: 'the static template the profile pins, shown on the Interaction profiles page',
  templateVersion: 'the static template version',
  'promptPolicy.allowedInjectionKinds': 'a closed vocabulary list, shown on the Interaction profiles page',
  'promptPolicy.untrustedEncoding': 'a single-valued literal',
  'toolDiscoveryPolicy.rootHelpRef': 'a single-valued literal',
  'toolDiscoveryPolicy.preloadNouns': 'a list of help nouns, shown on the Interaction profiles page',
  'toolDiscoveryPolicy.providerToolRegistrationAllowlist': 'an operation list, shown on the Interaction profiles page',
  'feedPolicy.scope': 'a single-valued enum',
  providerCaptureMode: 'a single-valued literal',
  'composerPolicy.schemaRef': 'composer wiring, not a behaviour budget',
  'composerPolicy.supportsReply': 'composer wiring, not a behaviour budget',
  'composerPolicy.supportsAttachments': 'composer wiring, not a behaviour budget',
  'composerPolicy.allowedAttachmentKinds': 'composer wiring, not a behaviour budget',
  'composerPolicy.operationBindings': 'composer wiring, not a behaviour budget',
};
