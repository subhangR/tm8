Tool UI uses the existing authenticated HTTP client and operation catalog. `ToolPort` is mounted on `Seam.commands.tools`; the real adapter uses `tools.*`, with paged `tools.runs.list` for history and `actions.list` for permission discovery. One history request returns visible runs and invoker metadata without fetching each graph edge's session. Secrets are sent once as `tools.secrets.bind.value`, and only `keyHint` is rendered. The generated Run form pins `expectedVersion`, sends `keepOpen=true`, and sends ephemeral secret overrides separately from non-secret inputs.

An open definition draft keeps the version it loaded. A conflict preserves it and offers a rebase or explicit overwrite. Rebase keeps local edits and newer untouched fields; overlapping edits require review before saving. Run is disabled until changes are saved or discarded.

The tool page v2 pieces: `RunHistory` (the newest-first `tools.runs.list` table, with running rows polled through `tools.runs.get`), `OutputDrawer` (one run's redacted tail, read fresh), `LastRunChip` (the header's newest run, from `ToolView.lastRun` or the polled history row), and `Versions` with `versions-model.ts` (`entities.versions` rows classified as `tm8 tool versions --format json` does: definition versions by default, a Show-all-writes toggle, a source diff through `kit/DiffView` from `source-diff.ts`). `version-field.ts` is the one place that names which number is "the version" (the execution version). Refusals are shown as the server gave them through `toolErrorOf` in `errors.ts` (PR-A's module, PR-B's block at its end) and `ToolErrorAlert`.

`ToolRunChip` reads the session's pinned `toolRun` outcome while `TerminalBody` continues to use PTY liveness. A tool exit therefore changes only the chip. `toolTabCloseEffect` terminates a live keep-open shell when the user explicitly removes its last tab; system navigation and other remaining tabs do not terminate it.

`adapter.test.ts` uses the authenticated transport and final operation catalog to verify routes, strict request schemas, source attribution, human-only secret controls, and paged run history, including unreadable/deleted sessions. The adapter exposes only the session pointer from a launch response.

`fixture.ts` and `e2e/tools-harness.html` simulate tool operations for UI checks. They never execute source or connect to a PTY. The browser check verifies the actual CodeMirror highlighting, page/config/Run UI and narrow layout against those fixtures. The terminal unit check proves the same `LiveTerminal` mount survives each tool exit state. A live server journey, including absence of secret environment variables, `TM8_AGENT_TOKEN`, and `TM8_SESSION_ID` in the leftover shell, belongs to Tools 5 after Tools 2's handlers and launcher land.

Checks:

```sh
bun run --cwd packages/tm8-ui test src/tools src/domain/registry.test.ts src/domain/edge-kinds.test.ts src/domain/edge-verbs.test.ts
bun run --cwd packages/tm8-ui typecheck
bun run --cwd packages/tm8-ui dev --host 127.0.0.1 --port 4864
node packages/tm8-ui/e2e/tools-browser-check.mjs
```

Set `TOOLS_UI_URL` or `TOOLS_CHROMIUM_PATH` when the fixture server or Chromium uses a different location.

Creating a tool (Tools v2 §3.1): `ToolCreateControl` is the one door — a dialog from the Tools list header (`EntityCreateControl`, `createForm: 'tool-definition'`), the New tab draft body (`ToolDraftBody` in `tab-workspace/adapters/draft.tsx`), and through `NEW_KINDS` the ⌘K palette's "New tool" and the `n u` chord. It shares `DefinitionForm` with the page's editor, prefills every field from a `TOOL_STARTERS` entry ("Start from a starter"), and sends the selection header with `entities.header.set` after `tools.create`; a header the node does not store (a node without migration 380) is a notice, never a failed create. `errors.ts` places a refusal where the server's zod issue path points (`definition.inputs.3.default`), puts a taken name (SQLSTATE 23505) on Name, and otherwise shows the server's own message. "Install starter tools" (`InstallStarters`) creates the missing starters by name through `tools.create`.

The tool page's Run reaches a terminal only through a session opener: `ToolLaunchProvider` (`context.tsx`) is mounted by the tab workspace's entity body (`tab-workspace/adapters/entity.tsx`) and opens the run's session as its own `work_session` tab.
