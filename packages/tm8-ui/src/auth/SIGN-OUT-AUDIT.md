# WHAT SURVIVES A SIGN-OUT — the audit nobody had done

**Date:** 2026-08-15. **Scope:** every module-level mutable value and every
persisted key in `packages/tm8-ui/src`. **Why it exists:** `signOutOfServer`
cleared the pass and nothing else for as long as it has existed, and the reason
that survived is not that anyone decided it was fine — it is that the set of
things which outlive a pass had never been written down. This file is that set.
The lesson is the list, not the two entries at the top of it.

**The test:** for each item, *if the next person to sign in on this browser is
somebody else, can they see it, or can something they see be derived from it?*
"Nobody would do that" is not an answer; "the key includes the viewer's member
id, so their read misses" is.

**Where the reset lives:** `auth/session-reset.ts` — one function, both ends of
a session (`signed-out` and `expired`), sharing its panel-clearing body with
`leaveSpaceContext` in `views/GateApp.tsx`. Address behaviour is ruled in
DECISIONS **D74**.

---

## 1. Cleared, because it leaked (this task's fixes)

| State | Where | What it held | End of session |
|---|---|---|---|
| `navStore` | `stores/navStore.ts` (module) | space id, view, panel stack, pins, per-panel tab/surface, `?session=` | `resetNav()` on BOTH ends |
| `screenStackStore` | `stores/screenStackStore.ts` (module) | every detail screen's entity stack | `clearAll()` on BOTH ends |
| `chatStore` | `channel-screen/chat-store.ts` (module singleton) | loaded feed pages, reply targets, in-memory drafts | `clearAll()` on BOTH ends |
| chat entity-chip cache | `chat-home/EntityChip.tsx` (module `Map`) | entity id → kind/title, up to 200 | cleared on BOTH ends |
| last place | `views/last-place.ts` → `tm8.last-place.v1.{node}` | last space **and last target, which can be `{type:'entity', ref:<id>}`** | `clearLastPlace(node)` on EXPLICIT sign-out only (D74) |
| launch-source cache | `data/launch-cache.ts` → `tm8.launch-sources.v1.{node}.{space}` | up to 400 `team_member` / `interaction_profile` rows | `clearLaunchCache(node)` on EXPLICIT sign-out only (D74) |
| launch recents | `data/launch-recents.ts` → `tm8.launch-recents.v1.{node}.{space}` | up to 50 `team_member` **ids**, in the order this viewer last launched them | `clearLaunchRecents(node)` on EXPLICIT sign-out only |
| the address | the browser hash | names a space and often an entity | blanked to `UNADDRESSED_HASH` on EXPLICIT sign-out only (D74) |

Two of these are worse than the reported bug in one respect: `last-place` and
the launch cache are **persisted**, so they survived a reload as well as a
sign-out, and `last-place` is actively *restored* into the next session by
`GateApp`'s boot. The chip cache has a second edge — a cached resolution would
have answered for an entity id **without re-asking the server**, so a viewer
whose own read would have been refused could have been shown a title.

## 2. Kept, and each is a ruling

| State | Where | Why it stays |
|---|---|---|
| known accounts | `auth/pass-store.ts` → `tm8ui.auth.known.v1` | the gate must still offer "sign back in as @amber". `session.ts`'s header rules this in terms: sign-out clears the pass WITHOUT forgetting which accounts have signed in here. Handles only, never a credential. |
| persisted chat drafts | `channel-screen/chat-store.ts` → `tm8:chat-draft:v1:{viewerMemberId,…}` | keyed by viewer member id, so the next viewer's read misses. Destroying half-written messages is a worse failure than the one this guards. |
| side-panel kinds | `views/useSidePanelKinds.ts` → `…{viewerId}.{spaceId}` | viewer-keyed; the next viewer reads their own key. The pattern the two leaks above should have followed. |
| session surface preference | `panels/bodies/WorkSessionContent.tsx` → `…:{viewerMemberId}:{sessionId}` | viewer-keyed, and a presentation toggle. |
| panel widths | `kit/PanelResizer.tsx` → `…entity.{kind}.list`, `entity.aux`, `channel.aside` | by KIND and view, never by entity or viewer. No content. |
| theme, shell override, real-seam and live-terminal flags | `theme/useTheme.ts`, `mobile/useShellKind.ts`, `views/realSeamFlag.ts`, `terminal/liveTerminalFlag.ts` | facts about this BROWSER, not this person. |
| node claim cache | `auth/session.ts` → `tm8ui.auth.nodeclaim.v1` | a fact about the NODE. Its own docblock: never the basis for a refusal. |
| model catalog delta | `domain/model-catalog.ts` → per node | this browser's edits to a model list. No graph content. |
| active server id, server origins | `servers/server-key.ts`, `auth/pass-store.ts` | where this browser points. Clearing it would eject the viewer from a named server they chose. |
| `activeNodeKey` | `domain/launch.ts` (module `let`) | a transport fact, set by the shell on server switch. |
| mutation sequences, clock listeners, `mermaidModule` | `data/real/ops.ts`, `authoring/commands.ts`, `kit/time.ts`, `kit/Mermaid.tsx` | counters and lazy imports. No identity, no ids. |

## 3. Torn down by the unmount, and why that is enough — with one caveat

`AuthGate` does not hide the app when signed out; it **does not render
`children` at all** (its own comment: "a gate that mounted the app underneath
would run its effects, open its sockets and fire its reads for a viewer who is
not in"). So everything React-owned goes on sign-out by construction:

- the domain store (`data/project/domain-store.ts`) is a `useRef` in
  `views/useGateData.ts`, one per `GateApp` mount;
- terminals: `LiveTerminal`'s unmount calls `ptyTransport.closeSession(id)`,
  which closes the socket and deletes every per-session map entry, and
  `registerTerminal`'s unregister drops the xterm instance, its buffered output
  and its visibility record.

**The caveat, which is a follow-up and not a fix here.** `terminal/pty` has no
whole-runtime teardown — no `closeAllSessions()`. Every path that removes state
is keyed by one session id and driven by one component's unmount. A session
whose terminal never mounted can leave buffered output in `runtime.ts`'s
`pending` map, and a socket opened for a session whose component never ran its
cleanup would not be closed by anything the sign-out does. It is bounded
(`MAX_PENDING_CHUNKS`) and it is not reachable through the UI without opening
that session again, so it is a residue rather than the exposure this task fixed
— but it is the one place where "the unmount handles it" rests on every unmount
actually happening.

## 4. The rule this leaves behind

**A module-level store or a persisted key that can hold graph content must be
keyed by the viewer, or it must appear in `auth/session-reset.ts`.** There is no
third option, and the two entries that had neither are precisely the two that
leaked. `views/useSidePanelKinds.ts` shows the first form; this file's §1 is the
second.

One loose end, left loose deliberately: `resetLocalAuth()` in `session.ts`
forgets every pass on every server and has **no callers** — it is a dev/test
affordance. It does not run the reset, because wiring it in would blank the
address of whichever test first adopts it, and a surprise is a poor thing to
leave in a helper. If it ever gains a real caller, that caller is ending a
session and must go through `endSession`.
