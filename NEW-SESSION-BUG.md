# "New session" on Home is a dead button — root cause

Investigated 2026-08-30 against the LIVE deployed UI (`https://tm8.sh`, bundle
`assets/index-C5ieVyFJ.js`), space `019fbd5a-3c5b-71ea-9b91-1d3baa50da25`,
driven in Firefox via Playwright.

**Verdict: UI owns this. One wrong kind literal. Fixed (one line + comment) in
this worktree at `packages/tm8_ui_2.0/src/home-page/HomePage.tsx:209`.**

The server is not at fault, and its refusal was correct.

---

## 1. The captured request and response

Clicking the Home card **New session** issues no session command at all. It
issues a generic entity create, with the kind literally `c:*`:

**Request**

```
POST https://tm8.sh/v2/entities

{"spaceId":"019fbd5a-3c5b-71ea-9b91-1d3baa50da25",
 "kind":"c:*",
 "title":"Untitled item",
 "clientMutationId":"au-1-125332a1-2ff0-484c-9543-3b9647f2ac1b"}
```

**Response — HTTP 409**

```json
{"error":{"code":"invariant_violation",
  "message":"unregistered entity kind: c:*",
  "details":{"sqlstate":"23514",
    "detail":"core kinds are global rows in entity_kinds; custom c:* kinds must be registered in this space"},
  "requestId":"req_2de2e9_1rk1","retryable":false}}
```

Toast rendered, verbatim: `create refused — invariant violation` /
`unregistered entity kind: c:*`.

### The `c:*` in the message is a REAL value, not a concatenation

This was an explicit open question. Settled: the request body contains
`"kind":"c:*"` as a literal string. `internal.validate_entity_kind()`
(`db/migrations/001_core_graph.sql:366`) interpolates `new.kind` into the
message, so `c:*` in the *message* is the value that was inserted. The `c:*`
that also appears in the `detail` field is an unrelated glob in a fixed English
sentence. The client displays `message` and `detail` in separate lines and is
not concatenating anything.

No `execution.terminal.start` request is made. `useSessionStart` is never
reached. `startTerminal()` is never called. The empty-string second argument
noted in the brief is a red herring — `useSessionStart.onAction` is
`(ref) => …` and never reads `entityId`, so passing `''` is harmless.

---

## 2. Root cause

`packages/tm8_ui_2.0/src/home-page/HomePage.tsx:209` (pre-fix):

```tsx
const session = kindVerb('session', 'New session', 'Put an agent on it and watch it work');
const task    = kindVerb('task',    'New task',    'Track a piece of work to done');
```

`'session'` is not a registry kind. The kind is **`work_session`**
(`packages/tm8_ui_2.0/src/domain/registry.ts:906`). `'task'` happens to be
correct (`registry.ts:693`), which is exactly why New task works and New
session does not.

The chain from that one literal to the 409, with the site at each step:

1. `HomePage.tsx:169` — `onCreateKind('session')` →
   `HomeView.tsx:659` → `birthFor('session')`.
2. `HomeView.tsx:451` — `rootBirthAction('session')`
   (`panels/ListRootHeader.tsx:28`) = `getKind('session').list.quickStart`.
3. `registry.ts:2347` — **`getKind` never throws; a miss returns the `c:*`
   fallback row.** The fallback row has no `quickStart`, so
   `rootBirthAction` returns `undefined`.
4. `HomeView.tsx:465` — with no birth action, `birthFor` takes the
   **generic-create arm** instead of the start-terminal arm, and computes
   `target = getKind('session')` — the fallback row again — whose own `.kind`
   is `CUSTOM_KIND_FALLBACK`, i.e. the string `'c:*'`
   (`domain/types.ts:1131`).
5. `birthFor` calls `newEntity.create({ kind: 'c:*', … })`.
6. `POST /v2/entities` with `kind: "c:*"` → the plpgsql trigger raises.

### Why nothing caught it — the card even rendered enabled

Two guards exist on this path and both wave `c:*` through:

- `useNewTask.unavailableFor` (`authoring/useNewTask.ts:126`) refuses a kind
  only when `creatableKind(kind) === null`. `creatableKind`
  (`authoring/commands.ts:149`) delegates to `CreatableEntityKindSchema`, whose
  custom arm is `CustomEntityKindSchema`
  (`packages/contract/src/schemas.ts:142`):

  ```ts
  (v) => typeof v === 'string' && v.startsWith('c:') && v.length > 2
  ```

  `'c:*'` starts with `c:` and is 3 chars long, so it **passes** — the sentinel
  is indistinguishable from a real custom kind by that predicate.

- The fallback row's `list.quickCreate` is `true`, inherited from `baseList`
  (`registry.ts:508`), so the "not created from here" refusal never fires
  either.

Result: `birthFor(...).refusal === null`, so `HomePage.kindVerb` rendered a
live `<button>` rather than the disabled-with-reason `<span>`. Confirmed in the
browser — all three cards reported `disabled: false`. A wrong kind literal here
is silent from the click all the way to the database trigger.

---

## 3. Does the Sessions LIST HEADER's ＋ have the same failure? No — it works.

Measured, not inferred. The `ListRootHeader` rootbar is mounted on the **Work**
tab (`views/WorkspaceView.tsx`); it is no longer on Home. I opened the caret
menu, switched the kind cell to Sessions, and clicked its birth control.

The header renders the *right* control, because it is fed the registry's own
`config.kind` (`WorkspaceView.tsx` → `cell={{ kind: config.kind, … }}`, and on
Home `rootKindOptions` maps `homeRootKinds()` → `config.kind`), never a hand
written word:

```
cell:  "Sessions/▮/▾"
plus:  { label: "Terminal",
         title: "Start a terminal and open it — sessions are started, not authored" }
```

Clicking it:

**Request**

```
POST https://tm8.sh/v2/execution/terminal

{"clientMutationId":"terminal:019fbd5a-3c5b-71ea-9b91-1d3baa50da25:1788121684896",
 "spaceId":"019fbd5a-3c5b-71ea-9b91-1d3baa50da25",
 "projectId":"019fbe8f-28b4-72ab-8b60-4834dd80f56f"}
```

**Response — HTTP 201**

```json
{"data":{"entity":{"id":"01a0545b-9bb6-7028-880f-8c5def78e470",
  "kind":"work_session","title":"Terminal","category":"in_progress",
  "state":{"kind":"work_session","status":"running", …}}}}
```

…followed by a successful `streams-attach` (200) returning a live WS URL.

So the verb is healthy end to end. **The difference is exactly the argument
Home passes.** Every other call site of `birthFor` / `onCreateKind` derives the
kind from a registry row; `HomePage`'s three-card row is the only place that
hand-writes kind literals, and one of the two was wrong.

*(Cleanup: the two `work_session` rows my probes started —
`01a0545a-ddfa-72f3-adee-214ca02f2e49` and `01a0545b-9bb6-7028-880f-8c5def78e470`
— were terminated via `tm8 session terminate --yes`.)*

---

## 4. Server side — checked, and it is not the defect

`execution.terminal.start` is registered at
`packages/server/src/facade/execution-handlers.ts:2631`. It does not insert an
entity itself; it delegates to `spawnService.startShell(...)`, which creates a
`work_session` — proven above by the 201 whose entity is
`"kind":"work_session"`.

There is **no `c:*` anywhere on the server path.** The only `c:*` in the whole
chain is `CUSTOM_KIND_FALLBACK` in the UI registry. The server's contribution
is the trigger that refused the bad insert, which is the trigger doing its job:
`c:*` is a pattern, not a registered kind, and the node was right to say so.

**Owner: UI.** Nothing to fix on the server for this symptom.

---

## 5. The fix (applied)

Smallest correct change — `packages/tm8_ui_2.0/src/home-page/HomePage.tsx:209`,
one literal:

```diff
-const session = kindVerb('session', 'New session', 'Put an agent on it and watch it work');
+const session = kindVerb('work_session', 'New session', 'Put an agent on it and watch it work');
```

(committed with an explanatory comment above it, since the failure mode is
silent and the next reader will otherwise re-introduce it).

With `'work_session'`, `rootBirthAction` resolves to `'start-terminal'`,
`birthFor` takes the dispatch arm, and the card performs
`sessionStart.onAction('start-terminal', '')` → `POST /v2/execution/terminal` —
the identical path measured working in §3. The label stays "New session"
because `kindVerb` takes label and blurb explicitly; only the behaviour changes.

**Verification run** (narrow, not the full suite):

- `src/home-page/home-page.test.tsx` — 4 passed
- `src/chat-home/home-roots.test.tsx` + `src/views/gate.test.tsx` — 32 passed,
  1 skipped

No test pinned the old literal. Not deployed; not rebuilt into the prod bundle.

### Recommended follow-up (NOT applied — separate owner, separate change)

The bug was silent because `c:*` passes `CustomEntityKindSchema`. The codebase
already knows the sentinel is not addressable — `domain/menu.ts:190`
(`isMenuEligibleKind`) special-cases `if (ref === CUSTOM_KIND_FALLBACK) return
false;` for precisely this reason. `creatableKind`
(`authoring/commands.ts:149`) lacks the equivalent check, so a create can be
issued for the fallback row. Adding that identity check — either there or in
`CustomEntityKindSchema` (`packages/contract/src/schemas.ts:142`, which would
also close it for every other client) — would turn any future wrong kind
literal into a visible disabled-with-reason control instead of a 409.

---

## 6. The "New task" behaviour is by design, not a second bug

New task creating an "Untitled task" on the first click is deliberate — the
"D3" create-then-name rule, stated at `views/HomeView.tsx:422-425`: *"the
kind cell's ＋: create an 'Untitled {kind}' immediately, select it into B,
title focused in the panel. No compose form."* The same promise is written into
the header's tooltip ("Create an Untitled task and open it — type its name
there"), and `useNewTask` carries an explicit double-press guard to keep it
from firing twice.

It is worth flagging that on the Home *card* this promise is invisible: the
card's blurb is "Track a piece of work to done" and, unlike the header ＋, it
carries no title attribute saying an entity is created on press. If the
observed 210 → 211 was unwanted, the complaint is with the D3 rule or with the
card's wording, not with a defect in this code path — and it needs an owner
ruling, not a fix.
