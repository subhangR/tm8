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
//   - The operator's own skills (`<config>/skills/*`, and the claude.ai-synced
//     `anthropic-skills:*`) the launch did not equip: `skillOverrides` off.
//     An equipped one the harness loads natively goes `name-only`, because
//     tm8's skill index already carries its description (`laneSkillPlan`).
//     Plugin skills are NOT reachable this way — Claude Code ignores
//     `skillOverrides` for them (probed, 2.1.280, and documented) — so a
//     plugin stays all-or-nothing through `enabledPlugins`, and its record
//     says so (`granularity: 'plugin'`).
//   - The Claude in Chrome block (~4.1k chars of system prompt): `--no-chrome`.
//     Per invocation, so the operator's own Chrome setting is untouched.
//   - The harness Artifact tool: `CLAUDE_CODE_DISABLE_ARTIFACT=1`. tm8 lanes
//     publish with `tm8 artifact publish`; the harness tool publishes outside
//     tm8, and its prompt tells agents not to use it.
//
// `inherit` restores the bare command exactly, for a teammate that genuinely
// needs the operator's plugins or connectors.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

/**
 * The ONE always-on list: skill keys a `minimal` lane never names in
 * `skillOverrides`, so they stay fully listed whatever the launch equipped.
 * Only the bundled keep-four, by decision (D4.2): there is no operator
 * allowlist, because the launch's effective skills are the one source (design
 * 01a0d348 §3.1). An operator skill a teammate always needs is EQUIPPED — user
 * skills are skill entities too. A `skillOverrides` key is a bare command
 * name, so an operator skill sharing one of these names is left alone too:
 * turning it off would take the bundled skill with it.
 */
export const LANE_SKILLS_ALWAYS_ON: readonly string[] = [
  'code-review',
  'security-review',
  'simplify',
  'workflow-authoring',
];

/** The flag-level `skillOverrides` a `minimal` lane runs with when tm8 read no skills. */
export function laneSkillOverrides(): Record<string, 'off'> {
  return Object.fromEntries(LANE_BUNDLED_SKILLS_OFF.map((name) => [name, 'off' as const]));
}

/** A skill the lane's config home would list: `skills/<dir>` (`user`) or claude.ai-synced (`synced`). */
export interface ConfigHomeSkill {
  /**
   * The `skillOverrides` key: the dir name, synced skills included. Claude
   * Code 2.1.251 lists a synced skill as bare `<dir>` and 2.1.280+ as
   * `anthropic-skills:<dir>`; a bare key reaches it on both, a qualified key
   * only on the newer (probed, PR #803). A legacy command's key is its path
   * under `commands/` joined with ':' and without `.md` (`sub:name`); the bare
   * name does not reach a nested one (probed on 2.1.251 and 2.1.280).
   */
  key: string;
  level: 'user' | 'synced' | 'command';
}

/** Why a `minimal` lane's `skillOverrides` names a skill. */
export type SkillOverrideSource =
  | 'builtin-trim'
  | 'user-unselected'
  | 'synced-unselected'
  | 'command-unselected'
  | 'chrome';

export interface LaneSkillPlan {
  /** The flag-level `skillOverrides`, sorted by key. */
  settings: Record<string, 'off' | 'name-only'>;
  /** Whether argv carries `--no-chrome`; a replayed pre-#803 plan does not. */
  noChrome: boolean;
  /** `launch.harness.skillOverrides`: the same keys, each with its reason. */
  record: {
    off: { name: string; source: SkillOverrideSource }[];
    nameOnly: { name: string; source: 'native-name-only' }[];
    /**
     * Keys the lane left alone because a project skill or command (in its
     * workdir or a parent up to the git root) has the same name, and a
     * `skillOverrides` key reaches every skill of that name: the repo's own
     * skill stays listed. A synced skill is still turned off under its
     * qualified key (2.1.280+ only), recorded in `off` under that key.
     * Absent when nothing collided.
     */
    kept?: { name: string; because: 'project-collision' }[];
  };
}

/** The pseudo-name `launch.harness.skillOverrides.off` records `--no-chrome` under. */
export const CHROME_RECORD_NAME = 'claude-in-chrome';

/**
 * Levels whose native skills take a bare or `anthropic-skills:` key. Plugin
 * skills ignore `skillOverrides`; nested and admin keys were not probed.
 */
const NAME_ONLY_LEVELS: ReadonlySet<string> = new Set(['user', 'synced', 'project']);

/** The namespace 2.1.280+ lists synced skills under; keys drop it (see `ConfigHomeSkill.key`). */
const SYNCED_QUALIFIER = 'anthropic-skills:';

/**
 * What a `minimal` lane's `skillOverrides` says, and why, from the lane's
 * POST-BUDGET effective skills (design 01a0d348 §3): the harness loads only
 * what the launch chose.
 *   - bundled skills lanes never use: off (`builtin-trim`);
 *   - config-home skills the launch did not equip, or equipped but trimmed
 *     from the index: off (`user-unselected` / `synced-unselected`);
 *   - equipped skills the harness loads natively: `name-only`
 *     (`native-name-only`) — tm8's index already describes them, and
 *     `/name` and a model's Skill call still load them (probed). One whose
 *     description tm8's prompt does NOT carry (`described: false`: an empty
 *     description, or a context-index header the byte budget dropped) is
 *     named nowhere and stays fully listed, so its description survives in
 *     one place;
 *   - `--no-chrome`, which is argv, is recorded here as `chrome` so every
 *     trim is in one list.
 * Project skills nobody equipped are the repo's choice and stay listed.
 * Nothing in `LANE_SKILLS_ALWAYS_ON` is ever named.
 */
export function laneSkillPlan(
  homeSkills: readonly ConfigHomeSkill[],
  native: readonly { level: string; loadPointer: string; described?: boolean }[],
  projectKeys: readonly string[] = [],
): LaneSkillPlan {
  const project = new Set(projectKeys);
  const collided = new Set<string>();
  const kept = new Set(LANE_SKILLS_ALWAYS_ON);
  const nameOnly = new Set<string>();
  for (const skill of native) {
    if (!NAME_ONLY_LEVELS.has(skill.level) || !skill.loadPointer.startsWith('/')) continue;
    const pointer = skill.loadPointer.slice(1);
    const key = skill.level === 'synced' && pointer.startsWith(SYNCED_QUALIFIER) ? pointer.slice(SYNCED_QUALIFIER.length) : pointer;
    // A command name never holds a '/'; a path-shaped pointer is not one.
    if (key === '' || key.includes('/') || kept.has(key)) continue;
    // Equipped but undescribed in tm8's prompt: keep the harness's own listing.
    if (skill.described === false) kept.add(key);
    else nameOnly.add(key);
  }
  const off = new Map<string, SkillOverrideSource>();
  for (const name of LANE_BUNDLED_SKILLS_OFF) {
    if (project.has(name)) collided.add(name);
    else if (!nameOnly.has(name)) off.set(name, 'builtin-trim');
  }
  for (const { key, level } of homeSkills) {
    if (kept.has(key) || nameOnly.has(key)) continue;
    if (project.has(key)) {
      collided.add(key);
      // Only a synced skill has a second, narrower name to turn off.
      if (level === 'synced') off.set(`${SYNCED_QUALIFIER}${key}`, 'synced-unselected');
    } else if (!off.has(key)) off.set(key, `${level}-unselected`);
  }
  const settings: Record<string, 'off' | 'name-only'> = {};
  for (const key of [...off.keys(), ...nameOnly].sort()) settings[key] = nameOnly.has(key) ? 'name-only' : 'off';
  return {
    settings,
    noChrome: true,
    record: {
      off: [
        ...[...off].map(([name, source]) => ({ name, source })),
        { name: CHROME_RECORD_NAME, source: 'chrome' as const },
      ],
      nameOnly: [...nameOnly].sort().map((name) => ({ name, source: 'native-name-only' as const })),
      ...(collided.size > 0
        ? { kept: [...collided].sort().map((name) => ({ name, because: 'project-collision' as const })) }
        : {}),
    },
  };
}

const SKILL_OVERRIDE_SOURCES: ReadonlySet<string> = new Set<SkillOverrideSource>([
  'builtin-trim', 'user-unselected', 'synced-unselected', 'command-unselected', 'chrome',
]);

/**
 * A recorded `launch.harness.skillOverrides` turned back into the plan it
 * records, for resume to REPLAY (the way #765 replays plugins): a resumed
 * conversation boots with the harness it launched with, even if its equips
 * or the config home changed since. The record is stored JSON, so every
 * entry is checked; anything malformed returns null and resume computes a
 * fresh plan rather than half-apply one. `--no-chrome` is replayed only if
 * the record carries it, so a pre-#803 lane resumes without it, as launched.
 */
export function asRecordedSkillPlan(value: unknown): LaneSkillPlan | null {
  if (!isRecord(value) || !Array.isArray(value.off)) return null;
  const entry = (item: unknown, sources: ReadonlySet<string>): { name: string; source: string } | null =>
    isRecord(item) && typeof item.name === 'string' && item.name !== '' && typeof item.source === 'string' && sources.has(item.source)
      ? { name: item.name, source: item.source }
      : null;
  const off = value.off.map((item) => entry(item, SKILL_OVERRIDE_SOURCES));
  const nameOnly = (Array.isArray(value.nameOnly) ? value.nameOnly : []).map((item) => entry(item, new Set(['native-name-only'])));
  if (value.nameOnly !== undefined && !Array.isArray(value.nameOnly)) return null;
  if (off.includes(null) || nameOnly.includes(null)) return null;
  const kept = Array.isArray(value.kept)
    ? value.kept.filter((k): k is { name: string; because: 'project-collision' } =>
      isRecord(k) && typeof k.name === 'string' && k.because === 'project-collision')
    : [];
  const settings: Record<string, 'off' | 'name-only'> = {};
  const named = [
    ...off.filter((o) => o!.source !== 'chrome').map((o) => [o!.name, 'off'] as const),
    ...nameOnly.map((o) => [o!.name, 'name-only'] as const),
  ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, state] of named) settings[name] = state;
  return {
    settings,
    noChrome: off.some((o) => o!.source === 'chrome'),
    record: {
      off: off.map((o) => ({ name: o!.name, source: o!.source as SkillOverrideSource })),
      nameOnly: nameOnly.map((o) => ({ name: o!.name, source: 'native-name-only' as const })),
      ...(kept.length > 0 ? { kept: kept.map((k) => ({ name: k.name, because: k.because })) } : {}),
    },
  };
}

/**
 * The skills a Claude config home lists besides bundled and plugin ones:
 * `skills/<dir>/SKILL.md`, and the claude.ai-synced skills under
 * `skills/synced/<bucket>/<dir>/SKILL.md`, keyed by bare `<dir>` (see
 * `ConfigHomeSkill.key`). A user and a synced skill sharing a dir share one
 * key, so one override covers both. Best-effort,
 * like `readInstalledClaudePlugins`: no skills directory is the ordinary case.
 */
export function readConfigHomeSkills(configDir: string): ConfigHomeSkill[] {
  const out: ConfigHomeSkill[] = [];
  const root = join(configDir, 'skills');
  for (const dir of listDirs(root)) {
    if (dir === 'synced') {
      for (const bucket of listDirs(join(root, dir))) {
        for (const skill of listDirs(join(root, dir, bucket))) {
          if (hasSkillFile(join(root, dir, bucket, skill))) out.push({ key: skill, level: 'synced' });
        }
      }
    } else if (hasSkillFile(join(root, dir))) {
      out.push({ key: dir, level: 'user' });
    }
  }
  for (const key of readCommandKeys(join(configDir, 'commands'))) out.push({ key, level: 'command' });
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The names a lane's workdir lists on its own: `.claude/skills/<dir>` and
 * `.claude/commands/**` — the repo's choice, which the lane never turns off.
 * `laneSkillPlan` needs them because a `skillOverrides` key reaches every
 * skill with that name, operator's and repo's alike.
 *
 * Claude Code reads both from the workdir AND every parent up to the git root
 * (probed on 2.1.280: a workdir in a monorepo package lists the repo root's
 * skills and commands; a skill above the git root is not listed). So the walk
 * goes up to the first directory holding `.git` (a worktree's is a file).
 * Outside a repo it stops below the home dir, whose `.claude` is the operator's
 * own: reading it here would make every operator skill a "project" one.
 */
export function readProjectSkillKeys(workdir: string, homeDir: string = homedir()): string[] {
  const home = resolve(homeDir);
  const keys = new Set<string>();
  for (let dir = resolve(workdir); dir !== home; dir = dirname(dir)) {
    const root = join(dir, '.claude', 'skills');
    for (const skill of listDirs(root)) if (hasSkillFile(join(root, skill))) keys.add(skill);
    for (const command of readCommandKeys(join(dir, '.claude', 'commands'))) keys.add(command);
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) break;
  }
  return [...keys].sort();
}

/** `commands/a/b.md` → `a:b` (see `ConfigHomeSkill.key`); four levels deep at most. */
function readCommandKeys(root: string, prefix: readonly string[] = []): string[] {
  if (prefix.length > 3) return [];
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const path = join(root, name);
    if (isDirectory(path)) out.push(...readCommandKeys(path, [...prefix, name]));
    else if (name.endsWith('.md') && name.length > 3) out.push([...prefix, name.slice(0, -3)].join(':'));
  }
  return out;
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path).filter((name) => !name.startsWith('.') && isDirectory(join(path, name)));
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasSkillFile(dir: string): boolean {
  try {
    return statSync(join(dir, 'SKILL.md')).isFile();
  } catch {
    return false;
  }
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
  /**
   * `granularity: 'plugin'`: an allowed plugin lists ALL its skills, chosen or
   * not. Claude Code ignores `skillOverrides` for plugin skills (probed on
   * 2.1.280, and documented), so no finer trim exists; recorded so the
   * limitation is visible rather than silent (decision D4.1).
   */
  allowed: { id: string; source: PluginAllowSource; granularity: 'plugin' }[];
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
    if (source) out.allowed.push({ id, source, granularity: 'plugin' });
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
 * Per installed plugin id, the skill entities that belong to it: a
 * `level:'plugin'` Claude skill row whose `pluginName` the id matches by
 * `isPluginAllowed` — the same test `pluginDecisions` applies to
 * `equippedClaudePlugins`' names, so a skill listed here is exactly one that
 * would turn its plugin on at spawn. Plugins with none are left out (they are
 * MCP-only, and stay on the `plugins` / persona allowlist path). Design
 * 01a0d348 §3.5, F3.
 */
export function pluginSkillIds(
  installed: readonly string[],
  rows: readonly { entityId: string; provider?: string | null; level?: string | null; missing?: boolean; loaderMetadata?: Record<string, unknown> | null }[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of installed) {
    const ids = rows.flatMap((row) => {
      const name = row.loaderMetadata?.pluginName;
      return row.level === 'plugin' && row.provider === 'claude' && row.missing !== true
        && typeof name === 'string' && name !== '' && isPluginAllowed(id, [name])
        ? [row.entityId]
        : [];
    });
    if (ids.length > 0) out[id] = ids;
  }
  return out;
}

/** Which link of the precedence chain chose a lane's surface. */
export type HarnessSurfaceSource = 'launch' | 'env' | 'inherited' | 'persona' | 'default';

/**
 * `manifest.launch.harness` for a lane tm8 manages (design 01a0d348 §3.6):
 * the surface and who chose it, and under `minimal` everything the lane's
 * flags turn on or off — plugins (`pluginDecisions`), the MCP servers kept
 * under `--strict-mcp-config` (names only: a server config can carry a
 * token), and every skill `skillOverrides` names (`laneSkillPlan`). Built
 * from the same values `buildAgentCommand` reads, so the record and argv agree.
 */
export function laneHarnessRecord(
  launch: {
    harnessSurface?: HarnessSurface;
    harnessSurfaceSource?: HarnessSurfaceSource;
    mcpServers?: Record<string, unknown>;
  },
  plugins: HarnessPluginDecisions | null,
  skills: LaneSkillPlan['record'] | null,
): {
  surface: HarnessSurface;
  surfaceSource: HarnessSurfaceSource;
  plugins?: HarnessPluginDecisions;
  mcpServers?: { name: string; source: 'persona' }[];
  skillOverrides?: LaneSkillPlan['record'];
} {
  const surface = launch.harnessSurface ?? 'minimal';
  const surfaceSource = launch.harnessSurfaceSource ?? 'default';
  if (surface === 'inherit') return { surface, surfaceSource };
  return {
    surface,
    surfaceSource,
    ...(plugins ? { plugins } : {}),
    mcpServers: Object.keys(launch.mcpServers ?? {}).sort().map((name) => ({ name, source: 'persona' as const })),
    skillOverrides: skills ?? laneSkillPlan([], []).record,
  };
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
 * The one Claude config home a claude-code launch reads plugins from: the
 * member's credential home when they have one, otherwise the node's
 * (`CLAUDE_CONFIG_DIR`, else `~/.claude`). Never a union: spawn loads exactly
 * one home, so the launch menu (skills.preview) and the lane's deny-list both
 * resolve through here and agree.
 */
export function claudePluginConfigDir(
  memberConfigDir: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  return memberConfigDir || env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME ?? homedir(), '.claude');
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
