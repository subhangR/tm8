# Filesystem skill scanning

`discoverSkillFiles(roots)` discovers provider paths without reading bodies into
references. `parseSkillFile(candidate)` reads bytes, parses tolerant YAML and the
Codex sidecar, and returns metadata, hash, file size, mtime and bundle counts.
`scanSkills({ roots, store })` upserts metadata and marks absent references missing.
`SkillScanStore` is the persistence seam; missing references retain identities and
edges. Filesystem errors exclude the affected subtree from missing detection.

Server callers use `scanSpaceSkills(db, claims, spaceId, { root, force: true })`
after writing a skill. `root` is a project resource ID linked to the space. The
server resolves roots from authorized project data and configured home defaults,
with the OS account home as fallback. Project `defaults.homeDir`, `codexHome`, and
`hermesHome` may supply absolute configured roots. No arbitrary users' home
folders are inferred. All known authorized project roots bound nested traversal.

Manual scans force refresh. Spawn scans the project's roots and homes before
loading context; no-project spawns scan only home/provider conventions. Successful
scans debounce for 30 seconds and concurrent callers share work. Project creation
scans existing associations; because creation is node-wide, the initial reference
scan normally happens when `projects.link` or `spaces.projects.create` (W11)
establishes the space association.

`frontmatter` preserves parsed SKILL.md keys unchanged. `loader_metadata` carries
`openai` (the whole sidecar), `enabled`, `codexDisabled`, `legacyCommand`, and
optional `pluginName`. Disabled plugins remain discoverable.

Plugin keys (`pluginName`, also the `root_ref`) are stable contract, matched
against the CLI's `enabledPlugins` ids by `isPluginAllowed`:
- marketplace plugins (`.claude/plugins/marketplaces/<market>/plugins/<name>/`)
  use the bare `<name>`;
- claude.ai-synced plugins (`.claude/plugins/synced/<bucket>/<name>/`, listed by
  the bucket's `manifest.json`) use `<name>@synced`, the same id
  `readInstalledClaudePlugins` and `launch.harness.plugins` record. They are
  enabled unless `settings.json` sets `enabledPlugins["<name>@synced"]` to false.
Either way the native load pointer is `/<name>:<skill>` (the `@…` suffix is not
part of the CLI namespace). Description metadata
uses description, then when_to_use, then the first body paragraph. Full bodies
never enter the write RPC. `scannedAt` is returned on every scan and stored as
`last_seen_at` when observed; marking missing preserves the last observation time.

Reference identity is `(space_id, source_path)`: the same node-home file can be
imported independently into multiple Spaces with separate entities, equips,
versions, and events. The database fills omitted `space_id` from the envelope for
legacy graph-only create calls and rejects explicitly mismatched Spaces.
Project scans cover only their discovered conventions; nested `.agents` references
from additional directories are refreshed or marked missing only by a scan that
includes those directories. File reads and effective sets belong to F1/F3.
