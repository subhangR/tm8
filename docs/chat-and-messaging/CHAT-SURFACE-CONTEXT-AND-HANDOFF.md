# tm8 Chat surface — how it works, what was broken, what is still missing

Written 2026-07-31. Everything below was measured against the tree, the live
databases and the running nodes on that date. Where something is *not* proven,
it says so — treat the "NOT proven" section as load-bearing, not as a caveat.

File references are by SYMBOL, not line number: several lanes are editing these
files concurrently and line numbers went stale inside one session.

---

## 1. What the Chat surface is

A work session can be viewed two ways:

- **Terminal** — the xterm view of the PTY.
- **Chat** — a message feed with a composer, replies, attachments, @tags.

They are **two views of ONE session**, not two kinds of session. Chat is not a
separate connection to a model provider. A message posted in Chat is stored,
then a delivery worker **types it into that session's PTY**, and the agent
(Claude Code / Codex) sees it as if the user had typed it. The reply comes back
as terminal output.

That is the single most misunderstood fact about this feature. "Is the Chat UI
and Claude Code integration done" has two different answers depending on which
half is meant, and §6 splits them.

---

## 2. How the surface is chosen

### 2.1 The pin — written once, never changed

Every work session gets a row in `public.work_session_interaction_pins` at
birth. It records which Interaction Profile governs the session. It is immutable
and append-only by revision, so editing or retiring a profile later cannot
change how an already-running session behaves.

Two writers exist, and the interaction between them caused a real bug (§4.2):

| Writer | When | Source |
| --- | --- | --- |
| `internal.ensure_core_interaction_pin` | trigger, on every `work_sessions` INSERT | migration 015 |
| `internal.w2_record_interaction_profile_pin` | `SpawnService`, just after the session row exists | migration 027 |

The reader (`entity-read.ts`, `ENTITY_FROM`) takes the **highest `pin_revision`**
via a lateral join. So the spawn-path pin (revision 2) normally wins over the
trigger pin (revision 1).

Resolution precedence for which profile lands in the pin, from
`internal.w2_resolve_interaction_profile_for_launch` (migration 027):

1. `spawn_override` — the profile passed to `execution.spawn`
   (requires `internal.require_human_space_admin`)
2. `teammate_default` — the teammate's `defaults_to_profile` edge
3. `space_default` — `spaces.default_interaction_profile_id`
4. `core_default` — the built-in fallback

### 2.2 The snapshot has two halves, deliberately separated

`resolved_snapshot` (jsonb) carries:

- **`agentProjection`** — `promptPolicy`, `toolDiscoveryPolicy`, `feedPolicy`,
  `providerCaptureMode`. Intended for the agent.
- **`browserProjection`** — `templateKey`, `templateVersion`,
  `initialContentSurface`, `feedPolicy`, `composerPolicy`. Intended for the
  screen.

`packages/server/src/profiles/browser-projection.ts`
(`projectInteractionProfileForBrowser`) is **the only** pin→browser projector.
It copies a closed list of safe fields and never forwards the snapshot object,
so prompt/tool/credential policy cannot cross the dual-audience boundary by
accident. Preserve that property in any change here.

### 2.3 What the browser receives

```
content.interactionProfile = {
  pinRevision, templateKey, templateVersion,
  compatibility: 'supported' | 'unknown_template',
  chatEnabled: boolean,
  initialContentSurface: 'terminal' | 'chat',
  feedPolicy, composerPolicy
}
```

- `chatEnabled = feedPolicy.scope === 'session_chat_v1' && composerPolicy.operationBindings.includes('messages.post')`
- `compatibility` is `'supported'` only if `templateKey@templateVersion` is in
  `STATIC_CHAT_TEMPLATE_REGISTRY` (`w2-profile-resolver.ts`) — a **frozen,
  one-entry** registry: `tm8.chat.core@1`, whose own `initialContentSurface` is
  `'chat'`. There is deliberately no registration API.

### 2.4 How the UI resolves the opening tab

`packages/tm8-ui/src/panels/bodies/WorkSessionContent.tsx`, `resolveInitialSurface`:

1. `!profile?.chatEnabled` → **`'terminal'`**, and the component returns the
   terminal **with no tablist rendered at all** — not a hidden tab.
2. explicit `requestedSurface` (route / `contentSurface=<id>:chat` URL param)
3. viewer-local `localStorage` preference
   `tm8:work-session-surface:v1:<memberId>:<sessionId>` — written only by an
   actual tab click
4. `compatibility === 'unknown_template'` → `'terminal'` + a diagnostic banner
5. otherwise → **`profile.initialContentSurface`**

Mount seam: `EntityView`/`WorkspaceView` → `EntityDetailPanel` (archetype
`terminal`) → `WorkSessionContent` → `LazySessionChatSurface` →
`SessionChatSurface` (host adapter) → `ChannelScreen` (pure presentation).
Nothing below `WorkSessionContent` reads the profile; the host adapter receives
only derived props (`defaultLimit`, `composerPolicy`).

### 2.5 Chat message → agent

```
compose in Chat
  → messages.post
  → row in public.messages
  → public.reserve_session_message_delivery  (durable per-pair budget, 015 §7 / 019)
  → delivery worker (SEPARATE pg identity: tm8_delivery_worker)
  → writes bytes into the session PTY
  → agent sees typed input
```

The worker needs `TM8_DELIVERY_DATABASE_URL` authenticating **as**
`tm8_delivery_worker` (not merely able to `set role` to it —
`verifyDeliveryPrincipal` enforces this). Without it the node boots fine and
messages are stored but never reach a terminal; `main()` prints
`delivery: NOT CONFIGURED`.

---

## 3. Environments (get this wrong and you measure nothing)

| | UI | server | code | DB |
| --- | --- | --- | --- | --- |
| **prod** | 7777 | 7778 | frozen snapshot `~/.local/share/tm8-stable` | `tm8_stable` |
| **staging** | 8888 | 8887 | live tree `~/Desktop/Projects/tm8` | `tm8_staging` |

The old launchd node on **:4610 has been retired** (plist renamed
`…disabled-for-staging`). The CLI binary still defaults to `http://127.0.0.1:4610`
and will fail with "is tm8-server running?" — use `TM8_BASE_URL=http://127.0.0.1:7778`
or `tm8 --server staging`.

Prod is a **build**: editing the tree changes nothing there until a re-snapshot
and rebuild. Staging runs the tree.

---

## 4. What was actually broken (root cause, 2026-07-31)

### 4.1 PRIMARY — the installed server predated the whole feature

The server and the UI bundle are deployed **separately and drift
independently**. On the then-live :4610 node:

- UI bundle: current, **contained** the Chat surface.
- Server dist: 6 days stale. **No `dist/profiles/browser-projection.js` at all**,
  and `entity-read.js` never joined `work_session_interaction_pins`.

So the API simply omitted `content.interactionProfile`. The UI read
`profile == null` → `chatEnabled` false → rule 1 above → Terminal, no tabs.

It looked exactly like "the interaction profile is being ignored". It was not
being ignored; the answer never arrived. **Audit an install by CONTENT
(`ls dist/profiles/`, grep for a required symbol), never by mtime** — sibling
packages rebuild and make the whole dist look fresh.

### 4.2 SECONDARY — the trigger pin named a template that does not exist

`ensure_core_interaction_pin` stamped `template_key = 'core'`, while the launch
resolver's core default returns `'tm8.chat.core'`. `'core'` is not in the frozen
registry → `compatibility: 'unknown_template'` → forced Terminal + banner. The
snapshot that same trigger wrote already said `tm8.chat.core` internally; only
the column disagreed with its own payload. 23 of 101 sessions on the dev DB were
affected, all created ≤ 2026-07-29.

### 4.3 TERTIARY — no profile could ever choose a surface

`InteractionProfileDraft` had **no** surface field, and 027's snapshot builders
never emitted `initialContentSurface` into `browserProjection`. So
`browser?.initialContentSurface` was `undefined` on **every** pin and always fell
through to the template constant. The value was a two-state function of "is the
template recognised", not of anything an author chose.

The launch sheet compounded this: `useGateData.ts` spread the client-side
constant `CORE_CHAT_LAUNCH_PRESENTATION` onto every profile, so every profile
advertised "starts in Chat" regardless of behaviour.

---

## 5. What was changed

**`db/migrations/051_profile_selects_content_surface.sql`** — three
`create or replace`, each diffed against its original to prove a minimal delta:

- `internal.w2g12_profile_snapshot` — emits
  `'initialContentSurface', version_row.draft_json -> 'initialContentSurface'`
  into `browserProjection`. **The `validation_status = 'valid'` guard is
  preserved** (it was dropped in a first draft and caught by the diff — re-verify
  it if this function is ever rewritten).
- `internal.w1_core_pin_snapshot` — adds `'initialContentSurface', 'chat'`.
- `internal.ensure_core_interaction_pin` — writes `'tm8.chat.core'`.

**No existing pin was rewritten.** Pins are immutable and auditable; a backfill
would forge history. Legacy `'core'`-pinned sessions keep their old behaviour.

**Contract** — `initialContentSurface` added as **optional** to
`InteractionProfileDraft` and to the `interaction_profile` entity **state**
(`contract.ts` + `schemas.ts`). Optional is load-bearing: every draft written
before the field existed stays valid, and absent means "defer to the template",
which is exactly what those drafts already did.

**Server** — `entity-read.ts` selects
`profile_version.draft_json ->> 'initialContentSurface'` as
`ip_initial_content_surface` and spreads it via a `surfaceOf()` helper that emits
an **absent key** (not a guessed value) when the draft has no opinion.
`events/projector.ts` mirrors this exactly — the two readers must agree or the
same profile would describe itself differently over the feed than over a read.

**UI** — `useGateData.ts` reads `row.state.initialContentSurface`, falling back to
the template default, instead of asserting Chat for everyone.

---

## 6. Status — split by half, honestly

### 6.1 The BROWSER half: working and proven

- Live API (prod 7778 and the then-live dev node) returns
  `chatEnabled: true`, `compatibility: "supported"`,
  `initialContentSurface: "chat"` for real sessions.
- Prod DB `tm8_stable` has 051 applied; `pg_get_functiondef` confirms
  `ensure_core_interaction_pin` writes `tm8.chat.core`.
- Prod dist contains `browser-projection.js` and `ip_initial_content_surface`.
- Draft→projection mechanism proven in a **rolled-back** transaction:
  draft `terminal` → projects `terminal`; `chat` → `chat`; silent → null →
  template default.
- Message→PTY delivery is real: `session_message_deliveries` showed 15/16
  `delivered`, firing up to 18 minutes after session start (the one failure was
  `session_not_live` — the agent had exited).

### 6.2 The AGENT half: NOT built. This is the real remaining work.

The Interaction Profile is **inert on the launch path**. Traced through
`SpawnService.spawn`: the profile is resolved *after* `resolveLaunchConfig` and
is passed to **none** of `buildAgentCommand`, `withAgentPrompt`, `composeEnv`, or
`pty.spawnIfAbsent`. Same binary, same argv, same env, same PTY, whichever
profile is chosen.

- `packages/prompt/src/index.ts` emits the profile as **provenance text only** —
  ids, hash, template key, pin revision, then one fixed sentence. Every branch is
  `if (field exists)`, never `if (policy says X)`. The prompt is byte-identical
  across profiles apart from id strings.
- **`agentProjection` has ZERO non-test readers.** Grep
  `agentProjection|promptPolicy|toolDiscoveryPolicy` across `packages/server/src`,
  `packages/execution/src`, `packages/prompt/src`, `packages/cli/src`.
- The kernel path that *would* consume it
  (`packages/prompt/src/kernel.ts`, injecting `interactionProfile=…@…`) requires a
  `manifestVersion: "2"` bootstrap manifest. `SpawnService` writes `"1"` and
  **no v2 producer exists** — the only `pinRef` producers in the repo are test
  fixtures. `packages/prompt/src/catalog.ts` states this in-tree: *"composeManifest
  still emits manifestVersion '1', so the live spawn path takes the v1 frame"*.
  Re-verified 2026-07-31: the only `manifestVersion` values produced anywhere in
  `packages/execution/src` are `'1'`.

So: `promptPolicy` and `toolDiscoveryPolicy` are fully modelled, validated,
hashed, pinned — and control nothing.

### 6.3 NOT proven

- **No browser has been driven.** No Chrome extension was connected. Everything
  in §6.1 is from the API, the DB and tests — nobody has *seen* the Chat tab
  render, or typed into the composer in a real page.
- No end-to-end "pick a terminal-surface profile in the launch sheet → session
  opens on Terminal" run. The mechanism is proven at the DB layer only; no
  profile with `initialContentSurface: 'terminal'` has been authored, activated
  and spawned through the real UI.
- The optional contract field has no test asserting a draft carrying it survives
  propose → validate → activate → pin.

---

## 7. Hazards for whoever picks this up

- **Two stale halves.** Server dist and UI bundle drift independently. Check both.
- **`grep -c` on a minified bundle counts LINES.** A one-line bundle returns 1 or
  0 and reads like a real count. Use `grep -o … | wc -l`. Two wrong conclusions
  came from this in one session.
- **Deploying a tree build ships other lanes' in-flight work.** Building to fix
  the chat projection also shipped another session's entity-attention code, whose
  migration was unapplied — the fresh server then answered `42P01` on *every*
  entity read until 050 was applied too. Reconcile `applied_migrations` against
  `db/migrations/` before deploying.
- **`db/migrate.mjs up` applies ALL pending files** and cannot target one. It also
  refuses to run while `007_rpc_catalog.sql` shows drift (edited after apply).
  To land one file: trial as `begin; <file> rollback;` first (validates SQL *and*
  role permissions at zero risk), then
  `psql -v ON_ERROR_STOP=1 -1 -q -f <file> -c "insert into public.applied_migrations(filename, checksum, duration_ms) values ('<file>','<sha256 of bytes>',0)"`.
- **`TM8_DATABASE_URL` must be set** — the runner's fallback uses `$USER`, which
  is not a role, and reports "database unreachable".
- **Use the right test runner.** `cd <package> && ./node_modules/.bin/vitest run`.
  From the repo root the resolved vitest is the wrong version and reports "No
  test suite found" for every file — a counterfeit red. The banner's trailing
  path is the control.
- **tm8-ui timeouts are load-sensitive** (5s test / 10s hook). Under a busy
  machine, unrelated suites fail and the failing set changes between runs. Re-run
  suspects **in isolation** before believing a regression.
- `seam-real.test.ts` interface-census red is pre-existing and unrelated (it
  trips on the attention lane's `resolveAttention`).

---

## 8. Suggested next work, in order

1. **Drive a real browser.** Confirm the Chat tab renders on prod 7777 and that
   the composer round-trips to the agent. This is the cheapest missing evidence.
2. **Author a `terminal`-surface profile** through the real propose → validate →
   activate flow, spawn with it, and prove the session opens on Terminal. That
   closes §6.3's second gap and is the user-visible promise of migration 051.
3. **Decide the fate of `agentProjection`.** Either build the `manifestVersion: 2`
   producer so `promptPolicy`/`toolDiscoveryPolicy` actually govern the agent, or
   mark them explicitly unimplemented so nobody else reads the schema and assumes
   they work. Today the schema promises behaviour the runtime does not deliver.
4. Add a contract test for a draft carrying `initialContentSurface` end to end.
5. Consider whether legacy `'core'`-pinned sessions deserve a **new pin revision**
   (append, never rewrite) so they gain Chat too.
