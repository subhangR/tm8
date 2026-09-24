#!/usr/bin/env node
/**
 * migrate-launch-plugins-to-equips — design 01a0d348 §3.5 step 2–3 (task F3).
 *
 * A teammate's `capabilities.launch.plugins` names Claude plugins a lean lane
 * keeps. Since L2 (#757) every installed plugin's skills are skill ENTITIES
 * (`level:'plugin'`, `loaderMetadata.pluginName`, synced ones as
 * `<name>@synced`), and a plugin is turned on because an effective skill
 * belongs to it. So an allowlist entry that has skill entities is really
 * "equip these skills": this script moves each such entry to teammate
 * `equips` edges and narrows the allowlist to the entries with no skill entity
 * (MCP-only), which stay additive and are recorded as `source:'persona'`.
 *
 * HUMAN-RUN, NEVER AUTOMATIC. Selection never writes edges, and no migration
 * or boot step rewrites a persona: an operator runs this, reads the plan, and
 * applies it. It goes through the public API as that operator (`tm8 skill
 * equip`, `tm8 entity update` under a version guard), so RLS, the command
 * ledger and events all apply, and every write is undoable the ordinary way.
 *
 *   node scripts/migrate-launch-plugins-to-equips.mjs --teammate <id> [--teammate <id> …]
 *   node scripts/migrate-launch-plugins-to-equips.mjs --teammate <id> --apply
 *
 * Without `--apply` it only prints the plan. Run it with the `tm8` CLI pointed
 * at the space (TM8_SPACE / the CLI's current space), as a member who may edit
 * those teammates.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The plugin part of an allowlist entry or `pluginName`: `sales@synced` → `sales`. */
const bareName = (id) => String(id).split('@')[0];

/**
 * Does allowlist `entry` name the plugin a skill's `pluginName` belongs to?
 * Spawn's `isPluginAllowed(installedId, allowlist)` matches an installed id to
 * an entry by full id or bare name; the entry and the skill's `pluginName` can
 * each be bare (marketplace skills) or full (`<name>@synced`), so compare the
 * full ids when both are full and the bare names otherwise.
 */
export function entryMatchesPlugin(entry, pluginName) {
  if (entry === pluginName) return true;
  if (entry.includes('@') && pluginName.includes('@')) return false;
  return bareName(entry) === bareName(pluginName);
}

/**
 * The plan for one teammate. Pure: `skills` are `skills.list` items, `equipped`
 * the ids the teammate already equips.
 *   - `equip`: skill ids to equip (not already equipped), per entry;
 *   - `keep`: entries with no skill entity — the narrowed allowlist;
 *   - `moved`: entries that became equips.
 */
export function planMigration({ plugins, skills, equipped }) {
  const have = new Set(equipped);
  const pluginSkills = skills.filter((s) => s.state?.level === 'plugin' && s.state?.provider === 'claude'
    && s.state?.missing !== true && typeof s.state?.loaderMetadata?.pluginName === 'string');
  const keep = [];
  const moved = [];
  const equip = [];
  for (const entry of plugins) {
    const ids = pluginSkills.filter((s) => entryMatchesPlugin(entry, s.state.loaderMetadata.pluginName)).map((s) => s.id);
    if (ids.length === 0) {
      keep.push(entry);
      continue;
    }
    moved.push({ entry, skillIds: ids });
    for (const id of ids) if (!have.has(id) && !equip.includes(id)) equip.push(id);
  }
  return { keep, moved, equip };
}

function tm8(args) {
  const out = execFileSync('tm8', [...args, '--format', 'json'], { encoding: 'utf8' });
  // The CLI appends a `[journal: …]` accounting line after the JSON.
  return JSON.parse(out.split('\n').filter((line) => !line.startsWith('[journal')).join('\n'));
}

function pageAll(args) {
  const items = [];
  let cursor = null;
  do {
    const page = tm8([...args, '--limit', '200', ...(cursor ? ['--cursor', cursor] : [])]);
    items.push(...(page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return items;
}

function main() {
  const argv = process.argv.slice(2);
  const teammates = argv.flatMap((arg, i) => (argv[i - 1] === '--teammate' ? [arg] : []));
  const apply = argv.includes('--apply');
  if (teammates.length === 0) {
    console.error('usage: migrate-launch-plugins-to-equips.mjs --teammate <id> [--teammate <id> …] [--apply]');
    process.exit(2);
  }
  const skills = pageAll(['skill', 'list']);
  for (const id of teammates) {
    const entity = tm8(['entity', 'get', id, '--full']);
    const capabilities = entity.content?.capabilities ?? {};
    const launch = capabilities.launch && typeof capabilities.launch === 'object' ? capabilities.launch : {};
    const plugins = Array.isArray(launch.plugins) ? launch.plugins.filter((p) => typeof p === 'string') : [];
    const equipped = pageAll(['edge', 'list', '--source', id, '--type', 'equips']).map((edge) => edge.target?.id);
    const plan = planMigration({ plugins, skills, equipped });

    console.log(`\n${entity.title} (${id}) v${entity.version}`);
    if (plugins.length === 0) { console.log('  no capabilities.launch.plugins — nothing to do'); continue; }
    for (const m of plan.moved) console.log(`  move  ${m.entry} → equip ${m.skillIds.length} skill(s)`);
    for (const k of plan.keep) console.log(`  keep  ${k} (no skill entity: MCP-only, stays on the allowlist)`);
    console.log(`  equip ${plan.equip.length} new edge(s); allowlist ${JSON.stringify(plugins)} → ${JSON.stringify(plan.keep)}`);
    if (!apply || plan.moved.length === 0) continue;

    // Equip first: if the persona write then fails its version guard, the
    // allowlist still names the plugin, so nothing is lost in between.
    for (const skillId of plan.equip) tm8(['skill', 'equip', skillId, '--teammate', id]);
    const { plugins: _dropped, ...rest } = launch;
    const nextLaunch = plan.keep.length > 0 ? { ...rest, plugins: plan.keep } : rest;
    tm8(['entity', 'update', id, '--expect-version', String(entity.version),
      '--content', JSON.stringify({ kind: 'team_member', capabilities: { ...capabilities, launch: nextLaunch } })]);
    console.log('  applied');
  }
  if (!apply) console.log('\nplan only — re-run with --apply to write it');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
