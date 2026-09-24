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
 * Every `definedAt` is `file:line` from the repository root, and
 * `test/configs/registry.test.ts` fails when that line stops naming the knob —
 * so the locations cannot silently drift. The same suite fails when a
 * `env.TM8_*` read appears in a package source without an entry here or on
 * `NOT_CONFIG_ENV` below.
 */
import { FILE_MAX_SIZE_BYTES_DEFAULT } from '@tm8/contract';
import type { ConfigChangeRoute } from '@tm8/contract';
import { LANE_BUNDLED_SKILLS_OFF, MINIMAL_MCP_CONFIG } from '@tm8/execution';
import { BYTE_BUDGETS, LINKED_MANIFEST_MAX } from '@tm8/prompt';

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
  definedAt: string;
  /** Credentials and keys: reported as present/absent, never as a value. */
  secret?: boolean;
}

export interface CodeConstant {
  name: string;
  group: string;
  summary: string;
  definedAt: string;
  /** The live value, imported from where it is defined. */
  read: () => unknown;
}

/** A per-subject knob: its value is resolved per teammate or per profile. */
export interface SubjectKnob {
  name: string;
  summary: string;
  default: string | null;
  definedAt: string;
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
  { name: 'TM8_ENV', group: 'Network & access', summary: 'dev or prod. Picks the default data directory and, in prod, requires an https public origin.', default: 'dev', definedAt: `${CONFIG}:308` },
  { name: 'TM8_BIND', group: 'Network & access', summary: 'Address the server binds. Loopback only; publish through a TLS reverse proxy.', default: '127.0.0.1', definedAt: `${CONFIG}:440` },
  { name: 'TM8_PORT', group: 'Network & access', summary: 'Port the server listens on.', default: '4610', definedAt: `${CONFIG}:441` },
  { name: 'TM8_PUBLIC_ORIGIN', group: 'Network & access', summary: 'Origin a browser reaches this node at, when it differs from the bind address. Used for the first-run claim link.', default: null, definedAt: `${CONFIG}:500` },
  { name: 'TM8_ALLOWED_HOSTNAMES', group: 'Network & access', summary: 'Extra Host header names accepted (comma-separated).', default: null, definedAt: `${CONFIG}:517` },
  { name: 'TM8_ALLOWED_ORIGINS', group: 'Network & access', summary: 'Extra browser origins accepted (comma-separated).', default: null, definedAt: `${CONFIG}:522` },
  { name: 'TM8_NODE_MODE', group: 'Network & access', summary: 'single: a loopback caller is the owner. multi: everyone signs in.', default: 'single', definedAt: `${CONFIG}:489` },
  { name: 'TM8_DISABLE_AUTO_OWNER', group: 'Network & access', summary: 'Turns off the loopback auto-owner arm. Implied by multi.', default: 'false', definedAt: `${CONFIG}:570` },
  { name: 'TM8_MAX_BODY_BYTES', group: 'Network & access', summary: 'Request body cap; larger bodies answer 413.', default: String(8 * 1024 * 1024), definedAt: `${CONFIG}:455` },
  { name: 'TM8_IDEMPOTENCY_ENABLED', group: 'Network & access', summary: 'Command-ledger replay and dedup. Off only for a local loop.', default: 'true', definedAt: `${CONFIG}:560` },
  { name: 'TM8_AUTH_MAX_ATTEMPTS', group: 'Network & access', summary: 'Auth attempts per client per window.', default: String(DEFAULT_AUTH_RATE_LIMITS.maxAttemptsPerClient), definedAt: `${CONFIG}:575` },
  { name: 'TM8_AUTH_ATTEMPT_WINDOW_MS', group: 'Network & access', summary: 'Window for the per-client auth attempt count.', default: String(DEFAULT_AUTH_RATE_LIMITS.attemptWindowMs), definedAt: `${CONFIG}:580` },
  { name: 'TM8_AUTH_MAX_FAILURES', group: 'Network & access', summary: 'Consecutive auth failures per principal before refusal.', default: String(DEFAULT_AUTH_RATE_LIMITS.maxFailuresPerPrincipal), definedAt: `${CONFIG}:585` },
  { name: 'TM8_AUTH_FAILURE_WINDOW_MS', group: 'Network & access', summary: 'Window for the per-principal failure count.', default: String(DEFAULT_AUTH_RATE_LIMITS.failureWindowMs), definedAt: `${CONFIG}:590` },
  { name: 'TM8_UI_DIR', group: 'Network & access', summary: 'Built web UI bundle served for non-/v2 paths. Unset in dev, where Vite serves the UI.', default: null, definedAt: `${CONFIG}:550` },

  // ── Storage & database ───────────────────────────────────────────────
  { name: 'TM8_DATABASE_URL', group: 'Storage & database', summary: 'Postgres connection string for the graph.', default: null, definedAt: `${CONFIG}:552`, secret: true },
  { name: 'TM8_DELIVERY_DATABASE_URL', group: 'Storage & database', summary: 'Separate Postgres connection for message delivery.', default: null, definedAt: `${MAIN}:313`, secret: true },
  { name: 'TM8_DB_POOL_MAX', group: 'Storage & database', summary: 'Postgres pool size — the node\'s read concurrency.', default: '8', definedAt: `${CONFIG}:471` },
  { name: 'TM8_DB_STATEMENT_TIMEOUT_MS', group: 'Storage & database', summary: 'Per-statement timeout.', default: '12000', definedAt: `${CONFIG}:477` },
  { name: 'TM8_DATA_DIR', group: 'Storage & database', summary: 'Server-owned state root.', default: '~/.tm8 (prod) or ~/.tm8-dev (dev)', definedAt: `${CONFIG}:309` },
  { name: 'TM8_FILE_MAX_SIZE_BYTES', group: 'Storage & database', summary: 'Per-blob ceiling for file grants, the file service and the blob store.', default: String(FILE_MAX_SIZE_BYTES_DEFAULT), definedAt: `${CONFIG}:461` },
  { name: 'TM8_CLIPBOARD_DIR', group: 'Storage & database', summary: 'Where pasted clipboard images land; exported to every agent.', default: '<data dir>/clipboard', definedAt: `${CONFIG}:326` },
  { name: 'TM8_CLIPBOARD_MAX_BYTES', group: 'Storage & database', summary: 'Per-image ceiling for a clipboard paste.', default: String(CLIPBOARD_MAX_BYTES_DEFAULT), definedAt: `${CONFIG}:534` },
  { name: 'TM8_CLIPBOARD_RETENTION_DAYS', group: 'Storage & database', summary: 'Days a clipboard bucket survives (0 = keep).', default: String(CLIPBOARD_RETENTION_DAYS_DEFAULT), definedAt: `${CONFIG}:539` },
  { name: 'TM8_PG_PORT', group: 'Storage & database', summary: 'Port of the bundled Postgres sidecar.', default: '5442', definedAt: `${SIDECAR}:119` },
  { name: 'TM8_PG_APP_ROLE', group: 'Storage & database', summary: 'Role the server connects as.', default: 'tm8_app', definedAt: `${SIDECAR}:122` },
  { name: 'TM8_PG_DATABASE', group: 'Storage & database', summary: 'Sidecar database name.', default: 'tm8', definedAt: `${SIDECAR}:123` },
  { name: 'TM8_PG_SUPERUSER', group: 'Storage & database', summary: 'Sidecar superuser (migrations).', default: 'tm8', definedAt: `${SIDECAR}:124` },
  { name: 'TM8_REPO_ROOT', group: 'Storage & database', summary: 'Checkout the sidecar reads migrations from.', default: 'the running checkout', definedAt: `${SIDECAR}:127` },
  { name: 'TM8_PG_BIN_DIR', group: 'Storage & database', summary: 'Postgres binaries the sidecar runs.', default: 'discovered on PATH', definedAt: `${SIDECAR}:146` },
  { name: 'TM8_PG_LOCALE_PROVIDER', group: 'Storage & database', summary: 'initdb locale provider.', default: 'builtin', definedAt: 'packages/server/src/sidecar/cluster.ts:71' },
  { name: 'TM8_PG_LOCALE', group: 'Storage & database', summary: 'initdb locale.', default: 'C.UTF-8', definedAt: 'packages/server/src/sidecar/cluster.ts:72' },
  { name: 'TM8_PG_ENCODING', group: 'Storage & database', summary: 'initdb encoding.', default: 'UTF8', definedAt: 'packages/server/src/sidecar/cluster.ts:73' },
  { name: 'TM8_LOG_LEVEL', group: 'Storage & database', summary: 'Sidecar log level: error, warn, info or debug.', default: 'info', definedAt: 'packages/server/src/sidecar/log.ts:46' },

  // ── Lane launch ──────────────────────────────────────────────────────
  { name: 'TM8_AGENT_CMD', group: 'Lane launch', summary: 'Replaces the agent binary for every lane (an operator wrapper).', default: null, definedAt: `${MANIFEST}:301` },
  { name: 'TM8_HARNESS_SURFACE', group: 'Lane launch', summary: 'minimal or inherit for every Claude lane. Outranks the persona setting.', default: 'minimal', definedAt: `${MANIFEST}:460` },
  { name: 'TM8_READ_HINTS', group: 'Lane launch', summary: 'Installs the large-read hint hook on every Claude lane. Outranks the persona setting.', default: 'off', definedAt: `${MANIFEST}:467` },
  { name: 'TM8_PERMISSION_MODE', group: 'Lane launch', summary: 'Permission mode for every lane that does not request an access mode. Outranks the persona.', default: 'auto', definedAt: `${MANIFEST}:423` },
  { name: 'TM8_REQUIRE_CODEX_SANDBOX', group: 'Lane launch', summary: 'Refuses a Codex lane whose sandbox cannot be verified (1).', default: 'off', definedAt: `${SPAWN}:889` },
  { name: 'TM8_AUTO_TRUST_WORKSPACE', group: 'Lane launch', summary: 'Pre-trusts a lane\'s worktree in the agent config so it starts without a trust prompt (false turns it off).', default: 'true', definedAt: 'packages/execution/src/spawn/workspace-trust.ts:92' },
  { name: 'TM8_SESSION_CAP', group: 'Lane launch', summary: 'Concurrent agent sessions this node runs.', default: '8', definedAt: `${EXEC_HANDLERS}:1458` },
  { name: 'TM8_TERMINAL_CAP', group: 'Lane launch', summary: 'Concurrent human terminals this node runs.', default: '4', definedAt: `${EXEC_HANDLERS}:1484` },
  { name: 'TM8_WORKTREE_CAP', group: 'Lane launch', summary: 'Concurrent worktree lanes (0 = unlimited).', default: '0', definedAt: `${EXEC_HANDLERS}:1743` },
  { name: 'TM8_LAUNCH_BOOTSTRAP', group: 'Lane launch', summary: 'Seeds launchable personas and the current project at boot (0 turns it off).', default: 'on', definedAt: `${CONFIG}:558` },
  { name: 'TM8_PROJECT_DIR', group: 'Lane launch', summary: 'Project the launch bootstrap registers.', default: 'the server\'s working directory', definedAt: `${CONFIG}:559` },
  { name: 'TM8_PROJECT_ROOTS', group: 'Lane launch', summary: 'Directories offered when linking a project.', default: null, definedAt: 'packages/server/src/facade/services/w2/project-directories.ts:42' },
  { name: 'CLAUDE_CONFIG_DIR', group: 'Lane launch', summary: 'Claude Code config home a lane uses when no credential home is chosen.', default: '~/.claude', definedAt: `${SPAWN}:1368` },
  { name: 'CODEX_HOME', group: 'Lane launch', summary: 'Codex config home a lane uses when no credential home is chosen; also scanned for skills.', default: '~/.codex', definedAt: `${SPAWN}:1368` },
  { name: 'HERMES_HOME', group: 'Lane launch', summary: 'Hermes home scanned for skills.', default: null, definedAt: 'packages/server/src/skills/service.ts:30' },
  { name: 'CLAUDE_MANAGED_SETTINGS_DIR', group: 'Lane launch', summary: 'Claude Code managed-settings directory scanned for skills.', default: '/etc/claude-code', definedAt: 'packages/server/src/skills/service.ts:31' },
  { name: 'TM8_CHAT_SKILLS_DIR', group: 'Lane launch', summary: 'Skills plugin directory chat threads load.', default: null, definedAt: `${MAIN}:970` },

  // ── Containers ───────────────────────────────────────────────────────
  { name: 'TM8_CONTAINERS', group: 'Containers', summary: 'Container runtime gate (off disables it).', default: 'on', definedAt: `${CONFIG}:348` },
  { name: 'TM8_CONTAINER_DATA_DIR', group: 'Containers', summary: 'Container state directory.', default: '<data dir>/containers', definedAt: `${CONFIG}:352` },
  { name: 'TM8_CONTAINER_PROVIDERS', group: 'Containers', summary: 'Enabled container providers.', default: 'docker,gvisor,android-emulator', definedAt: `${CONFIG}:361` },
  { name: 'TM8_CONTAINER_CAP', group: 'Containers', summary: 'Concurrent containers.', default: '4', definedAt: `${CONFIG}:368` },
  { name: 'TM8_CONTAINER_EXEC_CAP', group: 'Containers', summary: 'Concurrent container execs.', default: '8', definedAt: `${CONFIG}:369` },
  { name: 'TM8_CONTAINER_IMAGE_REGISTRY', group: 'Containers', summary: 'Registry container images are pulled from.', default: 'ghcr.io/subhangr/tm8', definedAt: `${CONFIG}:371` },
  { name: 'TM8_CONTAINER_KEEP_FAILED', group: 'Containers', summary: 'Keeps failed containers for inspection.', default: 'false', definedAt: `${CONFIG}:372` },

  // ── Previews & voice ─────────────────────────────────────────────────
  { name: 'TM8_PREVIEW_ENABLED', group: 'Previews & voice', summary: 'Artifact preview server.', default: 'true', definedAt: `${CONFIG}:655` },
  { name: 'TM8_PREVIEW_FRAME_ANCESTORS', group: 'Previews & voice', summary: 'Extra origins allowed to frame previews.', default: null, definedAt: `${CONFIG}:678` },
  { name: 'TM8_PREVIEW_HOST', group: 'Previews & voice', summary: 'Preview server bind host.', default: 'derived from TM8_BIND', definedAt: `${CONFIG}:686` },
  { name: 'TM8_PREVIEW_PORT', group: 'Previews & voice', summary: 'Preview server port.', default: 'derived from TM8_PORT', definedAt: `${CONFIG}:687` },
  { name: 'TM8_PREVIEW_PUBLIC_ORIGIN', group: 'Previews & voice', summary: 'Origin browsers load previews from.', default: null, definedAt: `${CONFIG}:688` },
  { name: 'TM8_LIVEKIT_URL', group: 'Previews & voice', summary: 'LiveKit server for voice.', default: null, definedAt: `${CONFIG}:818` },
  { name: 'TM8_LIVEKIT_API_KEY', group: 'Previews & voice', summary: 'LiveKit API key.', default: null, definedAt: `${CONFIG}:819`, secret: true },
  { name: 'TM8_LIVEKIT_API_SECRET', group: 'Previews & voice', summary: 'LiveKit API secret.', default: null, definedAt: `${CONFIG}:820`, secret: true },

  // ── Keys ─────────────────────────────────────────────────────────────
  { name: 'TYPESAFE_API_KEY', group: 'Keys', summary: 'Node key for Jev (TypeSafe), used when a member has none.', default: null, definedAt: `${MAIN}:372`, secret: true },
  { name: 'ANTHROPIC_API_KEY', group: 'Keys', summary: 'Node fallback Anthropic key for launches.', default: null, definedAt: `${NODE_KEYS}:45`, secret: true },
  { name: 'OPENAI_API_KEY', group: 'Keys', summary: 'Node fallback OpenAI key for launches.', default: null, definedAt: `${NODE_KEYS}:46`, secret: true },
  { name: 'GH_TOKEN', group: 'Keys', summary: 'Node fallback GitHub token (launches and PR tracking).', default: null, definedAt: `${NODE_KEYS}:47`, secret: true },
  { name: 'GITHUB_TOKEN', group: 'Keys', summary: 'Alternative name for the node GitHub token.', default: null, definedAt: `${NODE_KEYS}:47`, secret: true },
  { name: 'TM8_GITHUB_TOKEN', group: 'Keys', summary: 'GitHub token PR tracking prefers over GITHUB_TOKEN / GH_TOKEN.', default: null, definedAt: 'packages/server/src/tracking/github.ts:729', secret: true },
];

export const CLI_ENV: readonly EnvKnob[] = [
  { name: 'TM8_BASE_URL', group: 'CLI', summary: 'Server the tm8 CLI talks to.', default: 'http://127.0.0.1:4610', definedAt: 'packages/cli/src/env.ts:28' },
  { name: 'TM8_CONFIG_PATH', group: 'CLI', summary: 'CLI config file.', default: '$XDG_CONFIG_HOME/tm8/config.json', definedAt: 'packages/cli/src/context.ts:102' },
  { name: 'TM8_CREDENTIALS_PATH', group: 'CLI', summary: 'CLI credentials file (forces the file store).', default: '$XDG_CONFIG_HOME/tm8/credentials.json', definedAt: 'packages/cli/src/credentials.ts:81' },
  { name: 'TM8_CREDENTIALS_MODE', group: 'CLI', summary: 'CLI credential store: keychain or file.', default: 'platform default', definedAt: 'packages/cli/src/credentials.ts:116' },
  { name: 'TM8_NO_CACHE', group: 'CLI', summary: 'Turns off the lane read cache.', default: null, definedAt: 'packages/cli/src/read-cache.ts:96' },
  { name: 'TM8_NO_RECEIPTS', group: 'CLI', summary: 'Turns off write receipts (1).', default: null, definedAt: 'packages/cli/src/receipt.ts:94' },
  { name: 'TM8_NO_TERSE_DEFAULT', group: 'CLI', summary: 'Full output instead of the terse default (1).', default: null, definedAt: 'packages/cli/src/args.ts:59' },
  { name: 'TM8_JOURNAL_CLASS', group: 'CLI', summary: 'Overrides the journal\'s agent class.', default: 'detected', definedAt: 'packages/cli/src/journal-stats.ts:58' },
  { name: 'TM8_GITHUB_API_BASE', group: 'CLI', summary: 'GitHub API base for tm8 task link-pr.', default: 'https://api.github.com', definedAt: 'packages/cli/src/commands/task.ts:390' },
  { name: 'DATABASE_URL', group: 'CLI', summary: 'tm8 doctor database, when TM8_DATABASE_URL is unset.', default: null, definedAt: `${DOCTOR}:338`, secret: true },
  { name: 'TM8_PG_HOST', group: 'CLI', summary: 'tm8 doctor Postgres host.', default: '127.0.0.1', definedAt: `${DOCTOR}:342` },
  { name: 'TM8_PG_USER', group: 'CLI', summary: 'tm8 doctor Postgres user.', default: '$USER', definedAt: `${DOCTOR}:340` },
  { name: 'TM8_DB', group: 'CLI', summary: 'tm8 doctor database name.', default: 'tm8_dev', definedAt: `${DOCTOR}:343` },
  { name: 'TM8_PG_MAJOR', group: 'CLI', summary: 'tm8 doctor expected Postgres major.', default: null, definedAt: `${DOCTOR}:359` },
  { name: 'TM8_PSQL', group: 'CLI', summary: 'tm8 doctor psql binary.', default: 'psql on PATH', definedAt: `${DOCTOR}:373` },
  { name: 'TM8_MIGRATIONS_DIR', group: 'CLI', summary: 'tm8 doctor migrations directory.', default: '<repo>/db/migrations', definedAt: `${DOCTOR}:476` },
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
  TRUSTED_CONTROL_TYPES: 'the closed vocabulary of control envelope types',
  DISCOVERY_PROMPT_FORM: 'prompt wording, shown on the Prompts page',
  COORDINATOR_KINDS: 'the closed vocabulary of coordinator anchors',
  ZERO_COST: 'the zero value of Jev cost accounting',
};

export const CODE_CONSTANTS: readonly CodeConstant[] = [
  { name: 'BYTE_BUDGETS', group: 'Prompt budgets', summary: 'Hard byte ceilings on every prompt tm8 injects. A profile may choose smaller, never larger.', definedAt: 'packages/prompt/src/budgets.ts:19', read: () => BYTE_BUDGETS },
  { name: 'LINKED_MANIFEST_MAX', group: 'Prompt budgets', summary: 'Linked entities listed in a launch prompt.', definedAt: 'packages/prompt/src/templates.ts:346', read: () => LINKED_MANIFEST_MAX },
  { name: 'LINKED_ROW_CAP', group: 'Prompt budgets', summary: 'Linked rows read for a launch before the prompt picks its subset.', definedAt: `${EXEC_HANDLERS}:179`, read: () => LINKED_ROW_CAP },
  { name: 'TEAMMATE_FIT_SCORE', group: 'Jev selection', summary: 'A teammate scoring at least this "fits" the work.', definedAt: 'packages/server/src/jev/groups.ts:27', read: () => TEAMMATE_FIT_SCORE },
  { name: 'TICK_SCORE', group: 'Jev selection', summary: 'A memory or skill at or above this is pre-ticked.', definedAt: 'packages/server/src/jev/groups.ts:29', read: () => TICK_SCORE },
  { name: 'CRITICAL_SCORE', group: 'Jev selection', summary: 'A row at or above this is always ticked.', definedAt: 'packages/server/src/jev/groups.ts:31', read: () => CRITICAL_SCORE },
  { name: 'MEMORY_TICK_LIMIT', group: 'Jev selection', summary: 'Most memories a launch can carry.', definedAt: 'packages/server/src/jev/groups.ts:33', read: () => MEMORY_TICK_LIMIT },
  { name: 'CANDIDATE_LIMIT', group: 'Jev selection', summary: 'Candidates Jev ranks per launch.', definedAt: 'packages/server/src/jev/candidates.ts:28', read: () => CANDIDATE_LIMIT },
  { name: 'TEXT_LIMIT', group: 'Jev selection', summary: 'Characters of a memory, persona or skill description that may leave the server.', definedAt: 'packages/server/src/jev/candidates.ts:30', read: () => TEXT_LIMIT },
  { name: 'LANE_BUNDLED_SKILLS_OFF', group: 'Lane launch', summary: 'Bundled Claude Code skills a minimal lane turns off (skillOverrides). Kept: code-review, simplify, security-review, workflow-authoring. Escape: persona harnessSurface inherit, or TM8_HARNESS_SURFACE=inherit.', definedAt: 'packages/execution/src/spawn/harness-surface.ts:55', read: () => LANE_BUNDLED_SKILLS_OFF },
  { name: 'MINIMAL_MCP_CONFIG', group: 'Lane launch', summary: 'MCP config a minimal lane runs under --strict-mcp-config.', definedAt: 'packages/execution/src/spawn/harness-surface.ts:73', read: () => MINIMAL_MCP_CONFIG },
  { name: 'DEFAULT_AUTH_RATE_LIMITS', group: 'Network & access', summary: 'Auth rate limits used when the TM8_AUTH_* variables are unset.', definedAt: 'packages/server/src/http/auth-rate-limit.ts:53', read: () => DEFAULT_AUTH_RATE_LIMITS },
  { name: 'RATE_LIMITED_AUTH_OPS', group: 'Network & access', summary: 'Operations the auth rate limits apply to.', definedAt: 'packages/server/src/http/auth-rate-limit.ts:73', read: () => [...RATE_LIMITED_AUTH_OPS] },
  { name: 'CLIPBOARD_IMAGE_MIME_TYPES', group: 'Storage & database', summary: 'Image types a clipboard paste accepts.', definedAt: 'packages/server/src/files/clipboard-store.ts:51', read: () => [...CLIPBOARD_IMAGE_MIME_TYPES] },
  { name: 'FILE_MAX_SIZE_BYTES_DEFAULT', group: 'Storage & database', summary: 'Per-blob ceiling when TM8_FILE_MAX_SIZE_BYTES is unset.', definedAt: 'packages/contract/src/contract.ts:5879', read: () => FILE_MAX_SIZE_BYTES_DEFAULT },
  { name: 'CLIPBOARD_MAX_BYTES_DEFAULT', group: 'Storage & database', summary: 'Clipboard image ceiling when TM8_CLIPBOARD_MAX_BYTES is unset.', definedAt: 'packages/server/src/files/clipboard-store.ts:111', read: () => CLIPBOARD_MAX_BYTES_DEFAULT },
  { name: 'CLIPBOARD_RETENTION_DAYS_DEFAULT', group: 'Storage & database', summary: 'Clipboard retention when TM8_CLIPBOARD_RETENTION_DAYS is unset.', definedAt: 'packages/server/src/files/clipboard-store.ts:113', read: () => CLIPBOARD_RETENTION_DAYS_DEFAULT },
];

/**
 * Per-teammate launch settings. The `capabilities.launch.*` rows are the
 * persona's launch bag, parsed by the same `memberLaunchPreferences` the spawn
 * path uses — the registry test fails when that function returns a key with no
 * row here. The rest are the teammate row. Node env named in `envName`
 * outranks the persona, exactly as `resolveLaunchConfig` does.
 */
export const TEAMMATE_KNOBS: readonly (SubjectKnob & { envName?: string })[] = [
  { name: 'capabilities.launch.harnessSurface', summary: 'Harness surface a Claude lane boots with.', default: 'minimal', definedAt: `${MANIFEST}:268`, change: 'persona', envName: 'TM8_HARNESS_SURFACE' },
  { name: 'capabilities.launch.plugins', summary: 'Plugins a minimal lane keeps.', default: 'none', definedAt: `${MANIFEST}:268`, change: 'persona' },
  { name: 'capabilities.launch.mcpServers', summary: 'MCP servers a minimal lane loads (--mcp-config under --strict-mcp-config). Server names only; their configs can hold credentials.', default: 'none', definedAt: `${MANIFEST}:268`, change: 'persona', display: (v) => (v && typeof v === 'object' ? Object.keys(v as object) : v) },
  { name: 'capabilities.launch.readHints', summary: 'Large-read hint hook on a Claude lane.', default: 'false', definedAt: `${MANIFEST}:268`, change: 'persona', envName: 'TM8_READ_HINTS' },
  { name: 'agent_tool', summary: 'Agent harness the teammate launches.', default: null, definedAt: `${EXEC_HANDLERS}:341`, change: 'persona' },
  { name: 'model', summary: 'Model the teammate launches with.', default: null, definedAt: `${EXEC_HANDLERS}:340`, change: 'persona' },
  { name: 'permission_mode', summary: 'Permission mode when the launch requests no access mode.', default: 'auto', definedAt: `${EXEC_HANDLERS}:341`, change: 'persona', envName: 'TM8_PERMISSION_MODE' },
];

const CORE_DRAFT = 'db/migrations/079_core_draft_prompt_policy_repair.sql';

/** Interaction-profile values, by JSON path into the draft, against the core default. */
export const PROFILE_KNOBS: readonly SubjectKnob[] = [
  { name: 'promptPolicy.kernelTemplate', summary: 'Kernel prompt template sessions on this profile get.', default: 'tm8.core.v1', definedAt: `${CORE_DRAFT}:66`, change: 'profile' },
  { name: 'promptPolicy.manifestMaxBytes', summary: 'Launch manifest byte ceiling (≤ BYTE_BUDGETS.manifest).', default: '4096', definedAt: `${CORE_DRAFT}:67`, change: 'profile' },
  { name: 'promptPolicy.kernelMaxBytes', summary: 'Kernel prompt byte ceiling (≤ BYTE_BUDGETS.kernel).', default: '6144', definedAt: `${CORE_DRAFT}:68`, change: 'profile' },
  { name: 'promptPolicy.initialContextMaxBytes', summary: 'Initial context byte ceiling.', default: '32768', definedAt: `${CORE_DRAFT}:69`, change: 'profile' },
  { name: 'promptPolicy.rollingControlMaxBytes', summary: 'Rolling control message byte ceiling.', default: '32768', definedAt: `${CORE_DRAFT}:70`, change: 'profile' },
  { name: 'toolDiscoveryPolicy.semanticMaxMatches', summary: 'Matches a semantic help search returns.', default: '5', definedAt: `${CORE_DRAFT}:78`, change: 'profile' },
  { name: 'toolDiscoveryPolicy.nounShardMaxBytes', summary: 'Byte ceiling of one noun help shard.', default: '8192', definedAt: `${CORE_DRAFT}:79`, change: 'profile' },
  { name: 'toolDiscoveryPolicy.commandShardMaxBytes', summary: 'Byte ceiling of one command help shard.', default: '16384', definedAt: `${CORE_DRAFT}:80`, change: 'profile' },
  { name: 'toolDiscoveryPolicy.entityContextDefaultBytes', summary: 'Default byte budget of entity context.', default: '16384', definedAt: `${CORE_DRAFT}:81`, change: 'profile' },
  { name: 'feedPolicy.pageSize', summary: 'Chat feed page size.', default: '50', definedAt: `${CORE_DRAFT}:84`, change: 'profile' },
  { name: 'feedPolicy.bodyExcerptBytes', summary: 'Chat feed body excerpt bytes.', default: '1024', definedAt: `${CORE_DRAFT}:84`, change: 'profile' },
];
