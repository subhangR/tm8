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
// including the repo's own. It turns off exactly three things:
//   - MCP servers: `--strict-mcp-config` with an empty config. Under strict
//     mode claude.ai connectors are not loaded at all. tm8 lanes reach tm8
//     through the `tm8` CLI, so tm8 owns no MCP server a lane needs.
//   - Plugins: every plugin found in the lane's config home that is not on
//     the allowlist is set `false` in a flag-level `enabledPlugins`.
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

/** The flag-level `enabledPlugins` that turns off every non-allowlisted plugin. */
export function disabledPluginSettings(
  installed: readonly string[],
  allowlist: readonly string[],
): Record<string, false> {
  const out: Record<string, false> = {};
  for (const id of [...installed].sort()) {
    if (!isPluginAllowed(id, allowlist)) out[id] = false;
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
