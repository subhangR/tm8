# Wave 0 — checkpoint handoff (Atlas → Vega)

**Status:** complete and browser-verified. Ready to commit.
**Rules honoured:** no git run · no vite build run · web-only · xterm DOM renderer untouched.

| Verification | Result |
|---|---|
| `npx tsc -b --pretty false` (packages/ui) | **EXIT 0** |
| `npx vitest run` (packages/ui) | **887 passed / 72 files**, up from 867 |
| Browser (playwright `channel:'chrome'`, 1600×1000) | Settings · Sessions · Home · list→open→**reload** all verified, **0 console errors** |
| Isolated stack used for session proof | tm8-server :4630 (`TM8_AGENT_CMD=echo-agent`) + vite :4612 + scratch db `tm8_uiverify` — **all torn down**, `:4611`/`:4620` untouched |

> No real Claude agent was spawned. The reattach proof used the documented
> zero-cost `echo-agent` stub on an isolated stack, so nothing was billed and no
> live instance was disturbed.

---

## 1. What the user can now do that they could not before

1. **Reach a running agent.** A Sessions rail entry → a list of every session,
   grouped live/finished → click one → its live terminal, streaming. Reload the
   page and you are still there. Previously a spawned agent existed only inside a
   modal's React state: closing it or reloading orphaned a live PTY permanently.
2. **Open Settings at all.** It was URL-only and white-screened the entire app.
3. **Survive a screen crash.** A broken screen now captions itself and offers
   Try again; the rails, nav and panels stay usable.
4. **See an unknown kind.** Any `c:*` custom kind renders as a plain card instead
   of white-screening the app.

## 2. Files changed

### Stop-the-app-dying
| File | Change |
|---|---|
| `collab-v2/kit/ErrorBoundary.tsx` | **NEW** — captioning boundary with `resetKey` + retry |
| `collab-v2/kit/index.ts`, `kit/kit.css` | export + styles (design tokens, dark-mode aware) |
| `collab-v2/shell/CenterHost.tsx` | boundary per view, keyed by route |
| `collab-v2/shell/PanelStack.tsx` | boundary per panel body |
| `collab-v2/registry/KindRegistry.tsx` | `fallbackKindEntry()`; `registryFor` takes `string`, never returns undefined |
| `real/RealFacade.ts` | `getSettings` returns the real `SpaceSettings` shape — **the `as unknown as` cast is gone**, so the compiler enforces it now |
| `collab-v2/types/contract.ts` | `SpaceSettings.unavailable?` — lets a partial backend say "can't serve" vs "empty" |
| `collab-v2/screens/settings/*` (4 files) | guards + honest per-section captions |

### The sessions surface
| File | Change |
|---|---|
| `real/sessions/SessionsScreen.tsx` | **NEW** — list (live/finished, status, agent, model, times) + detail with the live terminal, Prompt, Terminate |
| `real/sessions/sessions.css` | **NEW** — styled from `--pn-*` tokens |
| `collab-v2/CollabV2App.tsx` | **tm8 TOUCH #2**: optional `extraViews` prop |
| `main.tsx` | injects `{ sessions: SessionsScreen }` |
| `collab-v2/stores/nav.ts` | `sessions` view + `{view}/{entityId}` hash grammar |
| `collab-v2/shell/LeftRail.tsx` | **Sessions** and **Settings** rail entries (both were unreachable) |
| `collab-v2/shell/icons.tsx` | `terminal` icon |
| `collab-v2/subsystems/palette/actions.ts` | `sessions` label → ⌘K "go to Sessions" |
| `real/SpawnDialog.tsx` | spawn → navigate to `sessions/{id}` → dismiss. No longer holds session state or hosts a terminal |
| `real/tm8Kinds.tsx` | removed the stale "this node exposes no PTY route yet" paragraph |

### Correctness batch (worker lane, `sess_1784986448475_92ldk0dxr`)
| File | Change |
|---|---|
| `real/TmClient.ts` | added `delete()` / `put()` — 9 catalog ops were unreachable by transport |
| `real/RealFacade.ts` | `grantPoints` implemented (was throwing against a server that serves it) |
| `real/capabilities.ts` | removed the now-false `grantPoints` entry *(Atlas)* |
| `real/events.ts` | `toCursor()` — accepts the server's **string** `nextCursor`; guards NaN and monotonicity |

### Tests
| File | Change |
|---|---|
| `real/__tests__/sessions.test.tsx` | **NEW, REAL-PATH** — `SessionsScreen` → `RealFacade` → `TmClient` → HTTP, only `fetch` stubbed |
| `real/__tests__/transport.test.ts` | **NEW** — 13 tests incl. the anti-wedge cursor regression |
| `collab-v2/__tests__/shell/error-boundary.test.tsx` | **NEW** — containment + shell survival |
| `collab-v2/__tests__/entity/unknown-kind.test.tsx` | **NEW** — `c:*` renders, never crashes |
| `collab-v2/__tests__/foundation/stores-replay.test.ts` | **every** view round-trips through the hash |
| `collab-v2/__tests__/shell/shell-layout.test.tsx` | fixed a test that **asserted the bug** (expected a channel to serialize as `/e/`) |

## 3. Judgement calls you should sanity-check

1. **`extraViews` (a second touch inside the module).** The Sessions screen hosts
   a live PTY and reads `work_session`, a kind the module's `EntityKind` union
   does not contain — and the module may not import `real/`. Injecting through
   the existing `ViewRegistry` seam keeps that code on the tm8 side rather than
   forking the shell wiring. Mirrors `installTm8Kinds()`.
2. **F6 wired via data, not by importing `capabilities.ts`.** `collab-v2` must
   not import `real/`, so the honesty signal travels as `SpaceSettings.unavailable`
   and the sections caption from it. Wiring `capabilities.ts` directly into module
   screens would breach the seam. **The general F6 fix — a capability signal on
   the facade seam itself — is still open**; this covers only Settings.
3. **`window.prompt()` kept.** Replacing it is designed work (Wave 1). Kept so a
   reattached session is drivable today, with a comment saying so.
4. **Channel URLs changed spelling** — `#/s/{space}/channel/{id}` instead of
   `/e/{id}`. Old `/e/{id}` links still resolve (as the generic entity route,
   which is what they always actually did).
5. **Project trust default NOT flipped**, per your instruction. Full reasoning is
   now a comment at `RealFacade.createProject` pointing at Wave 3 + the missing
   `confirmUntrusted` contract field.

## 4. Z3 panel clipping — root cause was a class-name collision

`entity/entity.css` and `shell/shell.css` **both define `.cv2-panel`**, for two
different components: the EntityPanel (`width: clamp(420px,100%,560px)`) and the
shell's panel frame (`width: 440px; flex: none`). The shell hosts the EntityPanel,
so they nest — and the inner one re-asserted a fixed width inside a parent that
already has 16px of body padding, plus a second border, radius and shadow.

Measured in Chrome at 1600px, before → after:

| Element | Before | After |
|---|---|---|
| inner `.cv2-panel` right edge | **1617** (overflows by +17) | **1583** (−17, inside) |
| `.cv2-panel__body` scrollWidth | **458** vs 440 client | **440** — no h-overflow |

Fixed in `entity/entity.css` with a nested-case rule (fill the frame, let the
frame own the chrome). **The underlying collision is NOT fixed** — renaming one
of the two classes touches both subsystems and their tests, and is worth doing
deliberately rather than inside this batch. It is commented at the fix site.

## 5. Not done (deferred, with reasons)

- **Renaming the `.cv2-panel` collision** (see §4) — a contained follow-up.
- The general F6 capability seam (see §3.2); only Settings is captioned today.
- Everything design-led: sessions IA polish, terminal chrome, prompt composer,
  auth, projects/spaces/custom-kind authoring.
