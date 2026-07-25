# collab-v2 transplant — drift ledger and handoff

The Collab V2 UI module transplanted from `maestro-ui/src/collab-v2/` and wired
to the live tm8 catalog via `RealFacade`.

- **Source:** `agent-maestro`, branch `feat/collab-v2-ui`, commit **`b422978`**
  ("test(collab-v2-ui): W5 — Sentinel acceptance suite"), extracted read-only
  with `git archive`. 270 files.
- **Dev server:** `bun run dev` → http://127.0.0.1:4611 (strictPort, loopback).
  Proxies `/v2` and `/health` to `TM8_SERVER_ORIGIN` (default `http://127.0.0.1:4620`).
- **Mock mode:** append `?mock` — the seeded in-memory world, no server needed.

## Status

| | |
|---|---|
| `tsc -p tsconfig.json --noEmit` | 0 errors |
| `vitest run` | **836 passed / 836** (65 snapshot files + 1 mapping suite) |
| Browser acceptance | **15/15**, console clean |

Acceptance covers, in one real-Chrome pass: real spaces and tasks render →
create a task in the UI → spawn an agent on it → session appears with live
status → prompt it → thread shows progress → complete the task. Every claim is
then **re-verified against Postgres over HTTP**, so "the UI says done" and "it
is done" are established separately.

## Drift ledger — changes INSIDE `src/collab-v2/`

Exactly **one** file. Everything else in the 270 is byte-identical to `b422978`.

### 1. `CollabV2App.tsx` — facade injection (approved; NOT compiler-forced)

Added optional `{ facade, spaceId, banner }` props. Calling `<CollabV2App />`
with no props is byte-for-byte the previous behaviour: it still builds its own
seeded world, derives its own space id, and keeps the simulation driver.

Also gates the simulation control on the mock existing — a "sim on/off" toggle
floating over live server data would imply the events are synthetic when they
are not.

Chosen over a parallel app root because this file's own header names it the
Atlas-owned integration point, and duplicating its composition to swap one value
would fork the shell wiring and let the copy rot silently.

> **The import-path pass was a no-op**, verified rather than assumed: the module
> has **zero** imports that escape itself.

## Everything else lives OUTSIDE the module

`src/real/` — `TmClient`, `RealFacade`, `events`, `capabilities`, `ModeBanner`,
`SpacePicker`, `SpawnDialog`, `tm8Kinds` — plus `src/main.tsx` and the host
`tsconfig.json` / `vite.config.ts` / `index.html`.

## ⚠ Open defect for Atlas — `registryFor` can return `undefined`

**A custom `c:*` kind white-screens the entire app.** The contract explicitly
supports custom kinds; the registry does not survive one.

```ts
export function registryFor(kind: EntityKind): KindEntry {
  return KIND_REGISTRY[kind];      // undefined for any unregistered kind
}
```

The signature promises `KindEntry` and the lookup has no fallback, so the first
unknown kind to reach a chip throws `Cannot read properties of undefined
(reading 'tint')` and the whole tree unmounts.

It surfaced because tm8's contract (03 §1) promoted **`work_session`** and
**`collection`** to core kinds that the snapshot's eleven-kind `EntityKind`
union does not contain. The live server returns a `work_session` the moment
anything is spawned, so the very first real render died. **A seeded mock world
that never produces those kinds cannot catch this.**

Worked around in `src/real/tm8Kinds.tsx`, which registers both kinds at boot
using only the module's exported surface — the "runtime KindRegistry path"
`README.md` already anticipates. The durable fix is upstream and deliberately
left to Atlas: widen `EntityKind`, add the entries, and give `registryFor` a
fallback so an unknown kind degrades to a generic chip instead of a white screen.

## Host config notes (why they are not stricter)

- **`tsconfig.json` mirrors the snapshot's own.** A stricter config produced 94
  errors — 71 in tests, the rest `noUnusedLocals` inside Atlas's module. That
  was config drift, not transplant breakage: the source excludes tests from
  `tsc` (vitest runs them) and does not set `noUnusedLocals`.
- **`paths` pins `react` to the local `@types/react`.** `@types/react-mentions`
  declares a floating `"@types/react": "*"`, which bun resolved to 19.x nested
  beside a React 18 app, so `MentionsInput`/`Mention` typechecked as React-19
  components and failed at their JSX use sites ("bigint is not assignable to
  ReactNode" is the tell). Types-only — esbuild strips types, the runtime was
  never affected.
- **`test.env.NODE_ENV = 'test'`** — carried from the snapshot's
  `vitest.config.ts`. Without it React resolves to its production build and
  every render dies with *"act(...) is not supported in production builds"*:
  339 failures that look like broken tests and are one missing env var.
- **`vitest.setup.ts`** — the snapshot's setup lived at
  `maestro-ui/src/__tests__/setup.ts`, **outside** the module, so the scoped
  `git archive` did not carry it. Under vitest 4 the
  `@testing-library/jest-dom/vitest` side-effect entry no-ops, so matchers must
  be registered explicitly.

## Degradation policy — three classes, not two

The rule: **never fabricate.** A fake task is worse than a missing panel,
because a user cannot tell it is fake and neither can the next engineer.
See `src/real/capabilities.ts`.

1. **Unbuilt reads → typed empties.** An empty list is a true statement, and it
   lets the surrounding screen render instead of crashing. Paired with
   `isUnavailable()` so a screen can caption the emptiness "not built" rather
   than let it read as "you have nothing".
2. **Unbuilt writes → rejected `CollabError('not_implemented')`.** A write that
   silently no-ops while the UI says "saved" is the failure this lane exists to
   prevent. Affordances backed by these should render *disabled*.
   - Rejected, **not thrown synchronously** — the methods are declared
     `Promise<…>`, so a synchronous throw would escape `….catch()` at every
     normal call site.
   - **`markRead` is the deliberate exception.** It is unbuilt, but the UI calls
     it *automatically* on thread view rather than from an affordance, so
     throwing produced an unhandled rejection on every thread open. It resolves
     as a no-op — truthfully, since the unread counters it would clear are
     hollow zeros. **The right axis is user-invoked vs automatic, not read vs
     write.**
3. **Hollow fields → prefer hiding the affordance.** The nastiest class: present,
   correctly typed, and permanently zero. A 501 throws and something catches it;
   a hollow field renders a confident `0` with nothing to catch and nothing in
   the console, so the screen looks *working-and-wrong* rather than broken. A
   real "0 unread" and an unbuilt "0 unread" are pixel-identical and only one is
   true. Query with `isHollow(path)` / `hollowReason(path)`.

A permanent banner states which world the app is in and how many operations are
unbuilt, so a gap is never silent.

## Honestly not done

- **No terminal.** Session status is polled and the panel says so, in those
  words. There is no PTY route on this node; an empty black rectangle would
  imply a live-but-quiet stream. Live attach was declined for this pass on
  purpose — the attach protocol has two silent-corruption failure modes
  (offset must snap to `AttachResult.next`, never `base + replay.length`; a
  `snapshot` replay must not be re-parsed as a `delta`) that should not land
  alongside a fresh 270-file transplant.
- **`entities.move` is 501**, so drag-to-reparent will refuse. Not worked around.
- **Drag-to-board-column** goes through `patchEntity` and should work, but has
  not been driven in a browser, so it is not claimed.
