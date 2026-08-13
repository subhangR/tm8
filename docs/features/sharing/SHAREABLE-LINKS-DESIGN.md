# Shareable entity & view links — deep-link routing and the signed-out path

**Status:** design + investigation. **Nothing implemented.** Twelve rulings below; R1 blocks the
half of the work that is not pure client routing.

**The originating requirement, verbatim (user, 2026-08-12):** *"i want to share these links of the
page, to any user, and he should be able to view that entity or view. so i can share an entity or
view, and the user clicks on it — if logged in shows the page, if not shows login -> page."*

---

## 0. The short version

The requirement decomposes into three pieces that have very different costs.

| Piece | What it needs | Cost |
|---|---|---|
| **A. A URL that names the page** | Already specified and already coded. The route grammar is frozen in `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` §2.1–2.2 and the codec is built and tested. | zero design, zero code |
| **B. Clicking it lands you there** | Mount the router — and this is *not* a one-line `attachRouter()` call, because the store the router mirrors is **not the store that decides what renders**. §3. | the real work |
| **C. "any user" can view it** | Blocked on R1. Today a link is readable **only by an existing member of that Space**, enforced in Postgres. Everything else is a server change, and one variant is a large one. §5. | 0 / medium / large |

The signed-out half — *"if not, shows login -> page"* — turns out to be the **cheapest** part, not
the hardest, for a reason §4 sets out: the gate is an in-place render swap, not a redirect, so the
browser never loses the hash. What it needs is a **precedence rule**, not a capture-and-replay
mechanism.

---

## 1. What is already true (verified in-tree, 2026-08-12, at `e36e6a4`)

Verified rather than assumed; file:line given so a reviewer can check each one.

1. **The grammar is frozen and total.** `docs/architecture/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md`
   §2.2 defines every route this requirement needs, plus the §2.1 slug/strategy registry, the
   canonical-reload rule (`e/{id}` with no `origin` resolves its companion from the registry
   strategy), legacy redirects, the 2048-char cap with its overflow tier order, and the
   push/replace history discipline. **We are implementing a spec, not writing one.**
2. **The codec is built and tested.** `packages/tm8-ui/src/routes/codec.ts` (443 lines) with
   `redirects.ts`, `q.ts`, `transport.ts`, `codec.test.ts`, `redirects.test.ts`.
3. **The router is built and never mounted.** `attachRouter()` at
   `packages/tm8-ui/src/stores/navStore.ts:378`; `screenStackStore.ts:31` says so plainly —
   *"`attachRouter` has never had a non-test caller."* So the app has **no URL state at all**: no
   shareable link, no back button, no reload-to-where-you-were.
4. **Nothing else in the app writes the hash.** The only `location.hash` / `history.*State` writes
   in `packages/tm8-ui/src` are inside `routes/transport.ts:23-34`. This is load-bearing for §4.
5. **The gate does not redirect.** `App.tsx:27-33` wraps everything in `<AuthGate>`;
   `auth/AuthGate.tsx:114-147` returns *either* the app subtree *or* `<AuthFlow>` from the same
   component. Signed out, children "are not rendered at all — not hidden, not mounted behind an
   overlay."
6. **Reads are authorized in Postgres.** `db/migrations/008_rls_policies.sql:26-34` —
   `internal.entity_readable(target)` is `visibility = 'space' AND internal.is_space_member(...)`.
   Line 31 is explicit that **`restricted` is inert in v1**: a restricted entity is readable by
   *nobody*, pending a `has_visible_to_edge` policy change.
7. **Invite redemption requires an existing account.** `redeem_invite`
   (`db/migrations/031_…:499-541`) calls `internal.require_identity()` at :528 before it does
   anything. You cannot redeem your way in from nothing.
8. **There is no open self-registration, deliberately.**
   `packages/server/src/facade/handlers/w2/auth.ts:51-53`: *"node-admin provisioning … an
   unauthenticated caller gets 28000, a non-admin 42501. No open self-registration."*
9. **`search.query` answers 501 by design** (`packages/contract/src/catalog.ts`). A link is
   therefore the *only* precise way to point a person at a specific entity today. That raises this
   task's value and is worth saying out loud.

---

## 2. The three findings that change the shape of the work

### F1 — `navStore.view` and `navStore.spaceId` are dead fields in production

This is the central finding and the reason "mount the router" is not a one-liner.

The router mirrors `Route = { spaceId, target: NavView, panels }`. But:

- `navStore.navigate(view)` (`navStore.ts:143`) has **no non-test caller**.
- `navStore.spaceId` is written **only** by `hydrate()` — which only `attachRouter` calls.
- What actually decides which screen renders is `GateApp.tsx:168` —
  `const [activeTarget, setActiveTarget] = useState<MenuTarget | null>(WORKSPACE_TARGET)` — a
  component-local `useState` seeded from `localStorage` via `views/last-place.ts`.
- Which *space* is active is `useGateData.ts:567` — another component-local `useState`.
- Which *entity is open inside a screen* is `screenStackStore`, keyed per screen instance, and
  **deliberately not persisted** (`screenStackStore.ts:33`, user ruling: in-memory only).

So `GateApp` reads exactly three things from `navStore` (`GateApp.tsx:222-224`): `stack`, `pinned`,
`contentSurface` — the workspace panel column, nothing else. **The router's `NavView` half is
wired to nothing.** Mounting `attachRouter` today would faithfully mirror a `view` field that no
screen consults, and the URL would change while the page did not.

The fix is to make `navStore` the single source of truth for *which screen*, and derive
`activeTarget` from it rather than holding it in `useState`. That is the shared change with the
mobile lane, and it is the bulk of Phase 1.

### F2 — `MenuTarget` and `NavView` are two vocabularies that do not align

`MenuTarget` (`shell/MenuRail.tsx:83-91`) vs `NavView` (`routes/types.ts:38-47`):

| `MenuTarget` | `NavView` | Problem |
|---|---|---|
| `{type:'view', ref:'dashboard'}` | `{view:'home'}` | name mismatch only — mechanical |
| `{type:'view', ref:'graph'}` (`GateApp.tsx:681`) | *(none)* | **no route exists.** R5 |
| `{type:'view', ref:'files'}` (`GateApp.tsx:749-750`) | *(none)* | **no route exists.** R5 |
| `{type:'kind', ref:'task', mode?}` | `{view:'kind', slug:'tasks', mode, q}` | `ref` is a **kind name**, `slug` is a **route slug**. The §2.1 registry is the mapping and already exists. |
| `{type:'entity', ref, kind}` — used for **channels** (`GateApp.tsx:666-669` renders `ChannelView`) | `{view:'entity', entityId, origin}` **and** `{view:'channel', channelId, msg}` are separate members | the rail's `'entity'` means *channel*; the route's `'entity'` means *entity detail*. A naive map is wrong in both directions. |
| *(no representation)* | the open entity inside a kind screen | lives in `screenStackStore`, not in `MenuTarget` at all |

The last row is the one that matters for the requirement: a shared link to **an entity** is
`e/{id}?origin=tasks`, and landing it correctly means setting *two* pieces of state, only one of
which is a `MenuTarget`. §3.2 gives the exact algorithm.

### F3 — `?msg={messageId}` has no consumer

The grammar (§2.2) and the codec both carry the channel message anchor. `views/ChannelView.tsx`
has **no message-anchor handling and no scroll-to-message** — the `anchorId`/`anchorTitle` symbols
there are the thread-anchor entity, a different concept. So "share a link to a specific message"
parses, round-trips, and then silently does nothing. Either it gets a scroll-to-and-highlight
implementation or the `msg` param should be documented as accepted-and-inert. R7.

---

## 3. Part B — the routing design

### 3.1 Where the router mounts, and what owns what

```
App.tsx
  └─ AuthGate                     ← signed out: renders AuthFlow. NEVER touches the hash. (R3)
       └─ ConnectedGateApp
            └─ GateApp            ← attachRouter() mounts HERE, once, per active server
                 ├─ navStore      ← now owns: spaceId + view + panels   (was: panels only)
                 ├─ activeTarget  ← DERIVED from navStore.view           (was: useState)
                 └─ screenStack   ← seeded from the URL on entity routes (was: URL-blind)
```

**Mount below the gate, not above it.** Above the gate the router would hydrate `navStore` and
start the store→URL write loop for a viewer who is not signed in — the exact thing `AuthGate`'s
contract exists to prevent, and it would also rewrite a visitor's link before they could sign in.
Below the gate, `attachRouter`'s own `readFromHash(target.getHash())` (`navStore.ts:472`) runs on
mount, which is *after* sign-in, and the hash is still there because nothing removed it. R3.

**Keyed per server.** `App.tsx:39` already remounts `GateApp` by `key={registry.activeServer.id}`,
so the detach/re-attach is free. A space id from one node means nothing on another
(`last-place.ts` header says exactly this), and the route grammar has no node segment until
Phase 2 (§2.2 last bullet) — so the **origin of the URL is the node**, and a link is only
meaningful against the host that served it. R8.

### 3.2 The landing algorithm — URL → screen

One function, `applyRoute(route: Route)`, called from `hydrate` and from the boot path. Per
`NavView` member:

| Route | `activeTarget` | `screenStack` | Panels |
|---|---|---|---|
| `home` / `feed` / `inbox` / `settings[/…]` | `{view, ref}` | — | from `p`/`pin`/`t` |
| `workspace?session=` | `{view,'workspace'}` | — | `session` auto-opens iff `p` and `pin` are both absent (§2.2) |
| `k/{slug}?mode=&q=` | `{kind, ref: kindOf(slug), mode}` | cleared for that key | from `p`/`pin`/`t` |
| `e/{id}?origin={slug[.mode]}` | `{kind, ref: kindOf(originSlug), mode}` | **push `id` onto `screenKeyOf.kind(kind)`** | from `p`/`pin`/`t` |
| `e/{id}` with **no** origin | companion resolved from the §2.1 **registry strategy** (canonical-reload rule) | same | same |
| `channels` | `{view,'channels'}` | — | — |
| `channel/{id}[?msg=]` | `{entity, ref:id, kind:'channel'}` | — | `msg` → F3 / R7 |

Two things to note. The `e/{id}` row is **the shape the requirement is actually about** and it is
the one that needs `screenStackStore` seeded from the URL — which is not a violation of that
store's "in-memory only" ruling (that ruling forbids *persisting* it; hydrating it from the
address bar is what the address bar is for), but it is a change to that store's stated contract
and should be ruled rather than assumed. R6.

The `e/{id}` with no origin row is where a **shared** link most often lands, because R10 proposes
that "Copy link" emit exactly that minimal form. The registry already answers it; this is the
canonical-reload rule doing the work it was designed for.

### 3.3 The reverse direction — screen → URL

Already built. `routeOf(state)` → `normalize` → `build` → `setHash`, with the ruled history
discipline: user navigation and explicit pin/unpin `pushState`, normalization and surface toggles
debounced `replaceState` (`navStore.ts:451-470`). The only change is that `navigateTo` in
`GateApp.tsx:178-181` stops calling `setActiveTarget` and starts calling `navStore.navigate()`,
which bumps `revision` and lets the existing loop write the URL. `last-place` keeps working
unchanged as the *fallback* when there is no URL to obey.

### 3.4 The unresolvable-link surfaces — three of them, all currently missing

A shared link is the first navigation in tm8 that can name something the viewer **cannot have**.
Every one of these needs an honest screen, and none exists:

1. **Wrong node.** The hash names a `spaceId` the active server does not return. Today
   `useGateData:886` would silently `setSpaceId(list[0].id)` and you would land somewhere else
   entirely, with no indication. Must become: *"This link is for a Space this server doesn't have.
   It may belong to a different tm8 node."*
2. **Not a member.** The space exists on the node but `is_space_member` is false, so
   `spaces.get` refuses. Must become: *"You're not a member of this Space — ask whoever sent you
   the link for an invite."* Note this is indistinguishable from (1) at the API surface unless the
   server chooses to say so, which is a deliberate information-disclosure decision. R4.
3. **Entity gone or unreadable.** Space is fine, `e/{id}` 404s (deleted, purged, or `restricted`
   and therefore inert per finding 6). §2.1 already rules the deleted-message case — standalone
   render with a tombstone banner and no companion — and that pattern extends.

**These three screens are the deliverable's honesty requirement.** A deep-link feature whose
failure mode is "you quietly land somewhere else" is worse than no deep links.

---

## 4. Part B′ — the signed-out path, which is smaller than it looks

The brief anticipated that a deep link arriving signed-out would need its destination **captured
before the gate and replayed after sign-in**. Verified in-tree, that is not required, and it is
worth being precise about why.

`AuthGate` (`AuthGate.tsx:114-147`) is a **render swap inside one React component**, not a
redirect. Signed out, the browser is still at `https://host/#/s/{space}/e/{id}`; the page simply
renders `<AuthFlow>` at that address. Nothing in the app writes the hash except `routes/transport.ts`
(finding 4), and that module only runs inside `attachRouter`, which only mounts inside `GateApp`,
which only renders when signed in. **So the destination survives sign-in for free.**

What is actually needed is a **precedence rule**, because the boot path races the URL:

```
sign-in succeeds
  → GateApp mounts
  → attachRouter readFromHash()        writes navStore.spaceId + view      ← the link
  → useGateData boot read resolves (async)
  → setSpaceId(readLastSpace(...) ?? list[0].id)                            ← last-place
  → restore effect setActiveTarget(readLastTarget(...) ?? WORKSPACE_TARGET) ← last-place
```

Without a rule, last-place wins because it lands second, and the link is silently discarded. The
rule: **an addressable hash present at boot outranks `last-place` for that boot.** `last-place`
applies only when the hash carries no addressable space — which is exactly what
`opts.onSpacePicker` (`navStore.ts:363, 411`) already signals. R3.

Two places where the destination genuinely *is* destroyed, and where a capture is warranted:

- **Server switch.** `GateApp` remounts by `key={activeServer.id}`; the incoming node has a
  different space set, and the old hash is meaningless against it. Detach, then re-read.
- **Sign-out.** `GateApp.tsx:592-598, 631-637, 977-980` clear nav state and force
  `{view:'workspace'}` on sign-out. Whether sign-out should also blank the hash is a real choice:
  leaving it means signing back in returns you to where you were (good); leaving it also means the
  address bar keeps naming an entity to whoever is now looking at the screen (a mild disclosure).
  R9.

**One rule with teeth, worth stating as law:** *the signed-out gate must never write the hash.* Not
`#/signin`, not `#/`, not a cleanup on unmount. Every such write destroys somebody's shared link.
This is cheap to enforce with a test and impossible to notice by inspection later.

---

## 5. Part C — "any user", answered honestly

This is R1 and it blocks everything in this section. The three readings are genuinely different
tasks and only one of them is client-only.

### (a) Share among people already in the Space — **works, client routing only**

`entity_readable` is satisfied, the link resolves, nothing server-side changes. Everything in §3
and §4 delivers this and nothing more is needed. **This is the whole of Phases 0–2.**

If this is what was meant, the task is a pure front-end task and can ship within the week.

### (b) Share to an outsider who joins the Space by following the link — **partly blocked**

The adjacent machinery exists — `spaces.invites.create` / `.revoke` / `.redeem`
(`catalog.ts:46-49`) — but there is a hole in the middle of the flow:

- `redeem_invite` requires `internal.require_identity()` (finding 7) — **you must already have an
  account to redeem an invite.**
- `auth.signup` is node-admin gated with no open self-registration (finding 8) — **an outsider
  cannot make an account.**

So the flow "click link → sign up → join Space → see entity" **cannot complete today**, and no
amount of client work closes it. Two ways out, and they differ a lot:

- **(b1) Operational.** A node admin provisions the account out of band; the recipient signs in and
  *then* redeems. No server change; the "share a link to any user" story becomes "share a link to
  anyone I've had an account made for". Client work: carry the invite code through the gate and
  redeem it after sign-in, then continue to the captured destination — a natural extension of §4's
  precedence rule, and `auth/InviteFrames.tsx` already has the 1h/1i/1j frames drawn (they are
  currently specimen-only: *"no operation reads an invite before you join"*).
- **(b2) A deliberate hole in the signup gate.** A new op — signup-with-valid-invite-code — that
  creates an account and membership in one transaction. This is a real security decision, not a
  convenience: it converts a node with no self-registration into one where a leaked invite code
  mints accounts. Rate limiting, invite expiry/`max_uses` (both already in `space_invites`), and
  audit all become load-bearing. Designable, but it needs its own review.

### (c) Share to an outsider who sees just that one entity without joining — **does not exist**

There is no public/unlisted share concept in the schema, the contract, or the policies. It would
need all three of: a share-token table, a read path that authorizes by token instead of
`is_space_member`, and a UI that renders one entity with no Space around it.

**Read `docs/features/artifacts/ARTIFACTS-DESIGN.md` §9.1 before designing this**, because it
already argued the adjacent case and the argument transfers. Artifact previews refused to serve
untrusted content from the app's origin: *"content served from an origin runs with the full
privileges of whatever origin served it … which, given auto-owner auth, is everything"* (§9.1).
An unauthenticated share page at the app origin is the same shape of mistake, and the same startup
assertion (`if (previewOrigin === appOrigin) refuse to start`, §9.2) would apply.

The good news is that the **token discipline is already precedent, not invention**:
`artifact_preview_sessions` (§5.2) stores `token_hash text not null unique check (~ '^[a-f0-9]{64}$')`
and never the token, with `expires_at` and `revoked_at` — *"a database read never yields a usable
credential."* A `entity_share_tokens` table would be that table with a different subject.

But it also carries questions that (a) and (b) do not: does a share reveal the entity's *comments*,
its *connections*, its *activity*? Its assignees' names? Is it revocable, does it expire by
default, is it listed anywhere the space can audit? Does it survive the entity being edited? Those
are a design session, not a paragraph. **If (c) is the answer, it should be its own task and this
one should ship (a) first regardless** — (a) is a strict prerequisite for (c) anyway, since (c)
still needs the routing to exist.

### The honest summary for R1

> Today, a tm8 link is readable by **existing members of that Space, and no one else** — enforced
> in Postgres, not in the client. (a) makes links work for them. (b) needs one server decision.
> (c) is a feature that does not exist and should be scoped separately.

---

## 6. Routes and navigation that must be set up

Nothing here invents grammar; it is the §2.2 list annotated with what is missing.

| Route | Codec | Screen wiring | Gap |
|---|---|---|---|
| `#/s/{s}/home` | ✅ | `dashboard` target | name map only |
| `#/s/{s}/feed` | ✅ | — | screen exists? verify at build time |
| `#/s/{s}/inbox` | ✅ | — | as above |
| `#/s/{s}/workspace?session=` | ✅ | `WORKSPACE_TARGET` + `nav.push` | precedence: `p`/`pin` beat `session` |
| `#/s/{s}/k/{slug}?mode=&q=` | ✅ | kind screen | slug↔kind via §2.1 registry (F2) |
| `#/s/{s}/e/{id}?origin=` | ✅ | kind screen **+ screenStack seed** | **the requirement's main case.** R6 |
| `#/s/{s}/e/{id}` (no origin) | ✅ | companion from registry strategy | canonical-reload rule |
| `#/s/{s}/channels` | ✅ | `channels` target | — |
| `#/s/{s}/channel/{id}?msg=` | ✅ | `ChannelView` | **`msg` inert** (F3). R7 |
| `#/s/{s}/settings[/projects\|/menu]` | ✅ | `settings` target | section routing |
| *graph* | ❌ **no route** | `GateApp:681` | R5 |
| *files* | ❌ **no route** | `GateApp:749` | R5 |
| legacy `#/s/{s}/tasks` etc. | ✅ `redirects.ts` | — | free once mounted |

Plus the three refusal surfaces in §3.4, which have no route because they are *states of a route*,
not routes.

---

## 7. The "Copy link" affordance

The routing is useless without a way to get the URL, and "select the address bar" is not it.

- **Placement:** entity panel header (the main case), kind-screen header, and channel header.
- **What it emits:** the **canonical minimal link** — space + target + `origin` — and *not* the
  viewer's `p`/`pin`/`t`/`contentSurface`. Sharing your open panel arrangement is noise at best and
  a disclosure of what else you had open at worst. The recipient gets the canonical-reload path.
  R10.
- **Insecure contexts are real here.** `navigator.clipboard` needs a secure context, and the
  terminal code already documents hitting exactly this (`terminal/LiveTerminal.tsx:346`: *"http://
  is not a secure context"*). On a plain-http node the button must fall back to a selectable text
  field or render disabled-with-reason — never a button that silently does nothing. The precedent
  for the honest-refusal shape is `panels/bodies/GovernedBody.tsx:319-341`, which already does the
  injected-copier → `navigator.clipboard` → refusal ladder for file paths. Reuse it. R11.

---

## 8. Phasing

**Phase 0 — the shared foundation** *(this is the mobile lane's Phase 0; it lands once)*
Make `navStore` own `spaceId` + `view`; derive `GateApp.activeTarget` from it; build the
`MenuTarget ↔ NavView` map against the §2.1 registry (F2). No `attachRouter` yet, no visible
change. Exit: every navigation in the app goes through `navStore.navigate()`, and the existing
suite is green.

**Phase 1 — mount it**
`attachRouter` in `GateApp`, the §3.2 landing algorithm, the §4 precedence rule, `onNotice` wired
to the existing `NoticeHost`, `onSpacePicker` wired to the space picker. Exit: reload returns you
to where you were; back/forward work; a pasted link lands.

**Phase 2 — make it shareable and honest**
The three §3.4 refusal surfaces, the §7 copy affordance, and the "gate never writes the hash"
test. Exit: **the requirement is met for reading (a)** — send a link to a colleague in the Space
and they land on it, signed in or signed out.

**Phase 3 — only after R1**
(b1) invite-code carry-through the gate; or (b2)/(c) as their own designed tasks.

**Test net** (all jsdom, all cheap, using the existing `createMemoryTarget` double):
URL→screen for every §6 row · screen→URL round-trip · back/forward walk · the signed-out precedence
race (hash present + `last-place` set → hash wins) · the gate-never-writes-the-hash assertion ·
each of the three refusal surfaces · overflow-drop notice on an over-cap link.

---

## 9. Coordination

Phase 0 + Phase 1 **are** the mobile brief's Phase 0
(`docs/features/mobile/MOBILE-DESIGN-BRIEF.md`, §3.2 and the phase list: *"Mount `attachRouter` so
URL ⇄ nav state round-trips and back/forward works … deep-linking works on desktop; back button
behaves"*). Same change, two motivations — shareable links here, the Android hardware back button
there. **It must be made once.** Proposal: this task lands Phases 0–2 and the mobile lane consumes
them. Messaged to the mobile task anchor `019ff655-115e-7c7e-b2b9-38060a23fb29`. R12.

---

## 10. The rulings

**R1 — blocking.** Which does "any user" mean: **(a)** already a member of the Space, **(b)**
outsider who joins via the link, or **(c)** outsider who sees just that entity without joining?
(a) is client-only. (b) needs one server decision. (c) is a feature that does not exist. *Nothing
in Phase 3 gets designed until this is answered; Phases 0–2 are needed under all three and can
start now.*

**R2 — if (b).** (b1) admin pre-provisions the account and the client carries the invite code
through the gate, or (b2) a new signup-with-valid-invite-code op that deliberately opens the
node-admin signup gate?

**R3 — precedence.** An addressable hash present at boot outranks `last-place`. Confirm. (Without
it the link is silently discarded by the async boot read.)

**R4 — refusal honesty.** When a link names a Space the viewer is not a member of, does the server
distinguish *"no such Space here"* from *"exists, you're not in it"*? The second is friendlier and
leaks the existence of a Space id to anyone holding a link. Recommend: **do not distinguish** at
the API, and have the client say *"you don't have access to this link's Space"* for both.

**R5 — unrouted screens.** `graph` and `files` are reachable from the rail but are not in the §2.2
grammar or the §2.1 registry. Register them (a spec amendment) or accept that they are
unshareable and un-reloadable?

**R6 — `screenStackStore` contract.** Seeding it from `e/{id}` on arrival is hydration, not
persistence, but it does change the store's stated "not persisted, a reload starts clean" ruling.
Confirm the URL may seed it.

**R7 — `?msg=`.** Implement scroll-to-and-highlight in `ChannelView`, or document the param as
accepted-and-inert until then? (It parses and round-trips today and does nothing.)

**R8 — cross-node links.** Confirm a shared link is only meaningful against the origin that served
it, and that the Phase-2 server prefix stays out of scope here.

**R9 — sign-out.** Leave the hash intact (signing back in returns you) or blank it (the address bar
stops naming an entity to whoever is now at the screen)? Recommend **leave it**.

**R10 — what "Copy link" emits.** Canonical minimal link (recommended) or the viewer's full panel
state?

**R11 — insecure-context copy.** Fallback text field, or disabled-with-reason, on a plain-http
node?

**R12 — lane ownership.** This task lands the router mount and the mobile lane consumes it.
Confirm.
