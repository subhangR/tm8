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
scan normally happens when `projects.link` establishes the space association.

`frontmatter` preserves parsed SKILL.md keys unchanged. `loader_metadata` carries
`openai` (the whole sidecar), `enabled`, `codexDisabled`, `legacyCommand`, and
optional `pluginName`. Disabled plugins remain discoverable. Description metadata
uses description, then when_to_use, then the first body paragraph. Full bodies
never enter the write RPC. `scannedAt` is returned on every scan and stored as
`last_seen_at` when observed; marking missing preserves the last observation time.

The schema specifies global path uniqueness. A reference already owned by a
different space causes an explicit per-file scan error; it is never modified or
reassigned. This means the same node-home file currently cannot be imported into
multiple spaces. This limitation needs a schema decision before wider multi-space
support. File reference reads and effective-set computation belong to F1/F3.
