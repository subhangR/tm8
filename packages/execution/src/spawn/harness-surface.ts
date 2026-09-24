// @tm8/execution — the harness surface a Claude Code lane boots with.
//
// A bare `claude` in a lane inherits everything the operator's account and
// config home carry: claude.ai-synced plugins (sales, marketing, operations,
// product-management, productivity), their skill listings, ~225 claude.ai
// connector tool names with their MCP server instructions, and the harness
// `Artifact` tool. None of it is tm8 work, and all of it is re-sent on every
// request of every lane — measured at ~13-16k tokens per request (doc
// 01a0d2e9, "Where lane tokens go now"). Chat threads already launch isolated
// (`ClaudeHeadlessAdapter.buildArgs`); this module is the lane half.
//
// `minimal` (the default) strips that surface. It does NOT use
// `--setting-sources` — that also drops the user's permissions and hooks — and
// it does NOT use `--disable-slash-commands`, which disables every skill,
// including the repo's own. It turns off exactly these:
//   - MCP servers: `--strict-mcp-config` with an empty config. Under strict
//     mode claude.ai connectors are not loaded at all. tm8 lanes reach tm8
//     through the `tm8` CLI, so tm8 owns no MCP server a lane needs. A
//     persona's `capabilities.launch.mcpServers` is the explicit opt-in.
//   - Plugins: every plugin found in the lane's config home that is not on
//     the allowlist is set `false` in a flag-level `enabledPlugins`; every one
//     that is (persona `plugins`, or the plugin of an equipped plugin skill)
//     is set `true`.
//   - Bundled skills lanes never use: `skillOverrides` off per name (see
//     `LANE_BUNDLED_SKILLS_OFF`).
//   - The harness Artifact tool: `CLAUDE_CODE_DISABLE_ARTIFACT=1`. tm8 lanes
//     publish with `tm8 artifact publish`; the harness tool publishes outside
//     tm8, and its prompt tells agents not to use it.
//
// `inherit` restores the bare command exactly, for a teammate that genuinely
// needs the operator's plugins or connectors.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type HarnessSurface = 'minimal' | 'inherit';

export const HARNESS_SURFACES: readonly HarnessSurface[] = ['minimal', 'inherit'];

export function asHarnessSurface(value: unknown): HarnessSurface | null {
  return typeof value === 'string' && (HARNESS_SURFACES as readonly string[]).includes(value.trim())
    ? (value.trim() as HarnessSurface)
    : null;
}

/**
 * Bundled Claude Code skills a `minimal` lane turns off with `skillOverrides`.
 * Lanes made 0 Skill calls across 89 transcripts (7d), and these are the ones
 * no lane work needs. Kept on purpose: code-review, simplify, security-review,
 * and workflow-authoring (the Workflow tool requires loading it first).
 * `disableBundledSkills` was rejected because it drops those too; `skillOverrides`
 * is per exact name ("*" is not a wildcard).
 */
export const LANE_BUNDLED_SKILLS_OFF: readonly string[] = [
  'claude-api',
  'dataviz',
  'fewer-permission-prompts',
  'init',
  'keybindings-help',
  'loop',
  'run',
  'schedule',
  'update-config',
];

/** The flag-level `skillOverrides` a `minimal` lane runs with. */
export function laneSkillOverrides(): Record<string, 'off'> {
  return Object.fromEntries(LANE_BUNDLED_SKILLS_OFF.map((name) => [name, 'off' as const]));
}

/** The empty MCP config a `minimal` lane runs under `--strict-mcp-config`. */
export const MINIMAL_MCP_CONFIG = '{"mcpServers":{}}';

/** Env a `minimal` Claude lane runs with, on top of `composeEnv`. */
export function harnessSurfaceEnv(launch: {
  agentTool: string;
  harnessSurface?: HarnessSurface;
}): Record<string, string> {
  if (launch.agentTool !== 'claude-code' || launch.harnessSurface === 'inherit') return {};
  return { CLAUDE_CODE_DISABLE_ARTIFACT: '1' };
}

/**
 * Whether `pluginId` (`<name>@<marketplace>`) is on the allowlist. An entry
 * matches the full id or the bare name, so `plugins: ["sales"]` means the
 * sales plugin from whichever marketplace installed it.
 */
export function isPluginAllowed(pluginId: string, allowlist: readonly string[]): boolean {
  const name = pluginId.split('@')[0];
  return allowlist.some((entry) => entry === pluginId || entry === name);
}

/**
 * The flag-level `enabledPlugins` for a `minimal` lane: every installed plugin
 * off unless allowlisted, and every allowlisted one explicitly on. The `true`
 * is the opt-in half — without it a plugin the user config leaves disabled
 * would stay off even though the teammate asked for it. Explicit flag-level
 * `false` beats the synced plugins' default-on (measured, claude 2.1.280).
 */
export function pluginSettings(
  installed: readonly string[],
  allowlist: readonly string[],
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const id of [...installed].sort()) out[id] = isPluginAllowed(id, allowlist);
  return out;
}

/** Why a plugin is on in a minimal lane. */
export type PluginAllowSource = 'launch' | 'effective-skill' | 'persona';
/** Why a plugin is off: removed from the persona list by a launch pick, or never chosen. */
export type PluginDenyReason = 'launch-pick' | 'not-chosen';

export interface HarnessPluginDecisions {
  allowed: { id: string; source: PluginAllowSource }[];
  denied: { id: string; because: PluginDenyReason }[];
}

/**
 * Every installed plugin's fate in a `minimal` lane, WITH the reason — the
 * manifest's `launch.harness.plugins`, so no trim is silent. Mirrors exactly
 * the allowlist `buildAgentCommand` applies: the launch pick (else the
 * persona list) plus the plugins of the lane's effective skills. A persona
 * plugin a launch pick left out is denied `launch-pick`, not `not-chosen`.
 */
export function pluginDecisions(
  installed: readonly string[],
  lists: { launchPick: readonly string[] | null; persona: readonly string[]; effective: readonly string[] },
): HarnessPluginDecisions {
  const out: HarnessPluginDecisions = { allowed: [], denied: [] };
  for (const id of [...installed].sort()) {
    const source: PluginAllowSource | null =
      lists.launchPick !== null && isPluginAllowed(id, lists.launchPick) ? 'launch'
        : isPluginAllowed(id, lists.effective) ? 'effective-skill'
          : lists.launchPick === null && isPluginAllowed(id, lists.persona) ? 'persona'
            : null;
    if (source) out.allowed.push({ id, source });
    else out.denied.push({ id, because: lists.launchPick !== null && isPluginAllowed(id, lists.persona) ? 'launch-pick' : 'not-chosen' });
  }
  return out;
}

/**
 * The plugins a lane's equipped skills live in. Equipping a Claude plugin
 * skill is choosing its plugin: without this the deny-list would turn the
 * plugin off and leave the skill's `/plugin:name` pointer aimed at nothing.
 */
export function equippedClaudePlugins(
  rows: readonly { provider?: string | null; level?: string | null; missing?: boolean; loaderMetadata?: Record<string, unknown> | null }[],
): string[] {
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.loaderMetadata?.pluginName;
    if (row.level === 'plugin' && row.provider === 'claude' && row.missing !== true && typeof name === 'string' && name !== '') {
      names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * The `--mcp-config` a `minimal` lane runs under `--strict-mcp-config`: empty
 * unless the teammate opted MCP servers back in (`capabilities.launch.mcpServers`,
 * the same `{ name: serverConfig }` shape as a `.mcp.json` `mcpServers` block).
 */
export function minimalMcpConfig(servers: Record<string, unknown> | undefined): string {
  return servers && Object.keys(servers).length > 0
    ? JSON.stringify({ mcpServers: servers })
    : MINIMAL_MCP_CONFIG;
}

/** Narrow a stored `mcpServers` bag: keep only object-valued entries. */
export function asMcpServers(value: unknown): Record<string, Record<string, unknown>> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, config] of Object.entries(value)) {
    if (name.trim() !== '' && isRecord(config)) out[name.trim()] = config;
  }
  return out;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The plugin ids a Claude config home would load, read at spawn so the
 * disable list names exactly what this lane's home carries. Three sources:
 *   - `plugins/installed_plugins.json` — marketplace installs. An install
 *     scoped ONLY to a project or local checkout is the repo's own choice
 *     (like a repo skill) and is left alone.
 *   - `plugins/synced/<bucket>/manifest.json` — claude.ai-synced plugins,
 *     which the CLI loads as `<name>@synced`. This is where the operator's
 *     sales/marketing/ops/pm/productivity plugins actually come from.
 *   - `settings.json` `enabledPlugins` — anything the user config turns on.
 * Best-effort: an unreadable or absent source contributes nothing, because a
 * config home with no plugins is the ordinary case, not an error.
 */
export function readInstalledClaudePlugins(configDir: string): string[] {
  const ids = new Set<string>();

  const installed = readJson(join(configDir, 'plugins', 'installed_plugins.json'));
  const plugins = isRecord(installed) && isRecord(installed.plugins) ? installed.plugins : {};
  for (const [id, installs] of Object.entries(plugins)) {
    const scopes = Array.isArray(installs)
      ? installs.map((i) => (isRecord(i) && typeof i.scope === 'string' ? i.scope : 'user'))
      : ['user'];
    if (scopes.length === 0 || scopes.some((s) => s !== 'project' && s !== 'local')) ids.add(id);
  }

  let buckets: string[] = [];
  try {
    buckets = readdirSync(join(configDir, 'plugins', 'synced'));
  } catch {
    buckets = [];
  }
  for (const bucket of buckets) {
    if (bucket.startsWith('.')) continue;
    const manifest = readJson(join(configDir, 'plugins', 'synced', bucket, 'manifest.json'));
    const entries = isRecord(manifest) && Array.isArray(manifest.plugins) ? manifest.plugins : [];
    for (const entry of entries) {
      if (isRecord(entry) && typeof entry.name === 'string' && entry.name !== '') {
        ids.add(`${entry.name}@synced`);
      }
    }
  }

  const settings = readJson(join(configDir, 'settings.json'));
  if (isRecord(settings) && isRecord(settings.enabledPlugins)) {
    for (const [id, on] of Object.entries(settings.enabledPlugins)) {
      if (on === true) ids.add(id);
    }
  }

  return [...ids].sort();
}

// ── Read hints (token-efficiency #3) ─────────────────────────────────────────
//
// A lane-only PostToolUse hook (`harness/read-hint.mjs`) that appends a short
// hint after a large repository read — `sed`/`cat`/`grep`… through Bash, or
// Read — pointing at line ranges and the code graph. It never caps or changes
// the output. It is independent of the harness surface: `inherit` strips
// nothing, but a lane still gets the hint unless `readHints` is off, which is
// also the A/B switch (`TM8_READ_HINTS=off`, or `launch.readHints: false`).

export function asReadHints(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (['1', 'on', 'true'].includes(v)) return true;
  if (['0', 'off', 'false'].includes(v)) return false;
  return null;
}

/** Absolute path to the read-hint hook, like `echoAgentPath`: `../../harness`
 *  lands on the same file from `src/spawn/` (vitest) and `dist/spawn/`. */
export function readHintHookPath(): string {
  return fileURLToPath(new URL('../../harness/read-hint.mjs', import.meta.url));
}

/** The `hooks` settings block that installs the read-hint hook. */
export function readHintHookSettings(hookPath: string = readHintHookPath()): Record<string, unknown> {
  return {
    PostToolUse: [
      {
        matcher: 'Bash|Read',
        hooks: [{ type: 'command', command: `node '${hookPath.replace(/'/g, `'\\''`)}'`, timeout: 5 }],
      },
    ],
  };
}
