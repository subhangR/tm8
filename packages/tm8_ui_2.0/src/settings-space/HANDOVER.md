# HANDOVER — T2 Settings, Trust & Authoring · HALF A

**status-as-of:** `6dce6da` (HEAD at start; nothing committed by me) · worker `sess_1785277829165_wlhq39sgi` · task `task_1785277828802_hi2ujhzv4` · 2026-07-29

Oracle: `T0-1 workspace structure review (1)/T2 Settings, Trust & Authoring Hi-Fi.dc.html` (80 032 bytes). My two frames — T2-1 (L21–142) and T2-3 (L275–391) — were read WHOLE, not sampled. Nothing outside `packages/tm8-ui/src/settings-space/` was created or edited.

Bar applied: **link-level completeness, fidelity deferred.** Every control the canvas draws exists and either works through the real seam or renders disabled-with-reason. No pixel was polished; a later parity session owns that.

---

## 0. The one sentence that governs this surface

**Every READ this surface needs already works; not one WRITE exists anywhere in `seam.commands`.** Space, members, viewer identity and menu all come back from a real seam (proved against `createFixtureSeam()` in `port-seam.test.tsx`). Role change, member removal, invite create/copy/revoke/redeem, space rename, transfer, delete, and **menu save** have no executor — so they render refused with the mechanism named. 18 refusals, all in `reasons.ts`, all counted and shape-asserted.

---

## 1. Frame enumeration — the oracle draws FIVE; I built TWO

| oracle `data-screen-label` | line | half | built |
|---|---|---|---|
| T2-1 — Space settings | 21 | **A (mine)** | ✅ |
| T2-2 — Projects & trust | 143 | B (sibling) | — |
| T2-3 — Menu editor | 275 | **A (mine)** | ✅ |
| T2-4 — Interaction profiles | 392 | B (sibling) | — |
| T2-5 — Custom-kind authoring | 496 | B (sibling) | — |

### What T2-1 and T2-3 decompose into, and what each needs

| sub-surface | built as | real through the seam | refused |
|---|---|---|---|
| T2-1a settings shell + 8-row section nav | `SettingsShell.tsx` | nav, section switching, all four reads | — |
| T2-1a `Profile` | `ProfileSection` | name / about / members / repo / created off `SpaceSummary` | Edit space details |
| T2-1b `Members & roles` | `MembersSection.tsx` | rows + role from `EntityState`; viewer handle from `identity()` | role change · remove · self-remove |
| T2-1c `Invites` | `InviteFrames.tsx` | **nothing — no capability** | create · copy · revoke · the whole list |
| T2-1d redeem landing (4 states) | `InviteFrames.tsx` | name typing | Join |
| T2-1a `Task axes` | `SettingsShell.tsx` | — | stated absence |
| T2-1a `Danger zone` | `DangerSection` | — | transfer · delete |
| T2-3a editor | `MenuEditor.tsx` | load, reorder (mouse + keyboard), rename, remove, add group/view/kind, discard, 8-child cap | **Save** |
| T2-3b live preview | `MenuEditor.tsx` | re-renders every keystroke in rail grammar | — |
| T2-3c conflict panel | `MenuEditor.tsx` | renders when host supplies a newer revision | Reload vN |
| T2-3d version-locked | `MenuEditor.tsx` | whole editor goes read-only | Save (the oracle draws it disabled too) |

**The nav names EIGHT destinations and the oracle draws ONE body.** Building only what is drawn would have shipped seven nav rows leading to blank panes. A test walks all eight and fails if any body renders under 40 characters.

---

## 2. Divergences — RULED vs DRIFT

### RULED (all by me, alone — flagged for ratification or reversal)

1. **The dark panels in the oracle are the DARK THEME, not a bespoke palette.** T2's conflict/version-lock cards paint `#221E15 / #262117 / #3B3524 / #EFE9DB / #BDB5A2 / #8C8470 / #665E4C / #6F9FC7 / #D9AA49` — every one of those is the *dark* value of `--pn-card / --pn-hover / --pn-line-2 / --pn-ink / --pn-ink-2 / --pn-ink-3 / --pn-ink-4 / --pn-info / --pn-wait`. So they are built as ordinary product surfaces in tokens and invert correctly, rather than as a nested dark scope. **Consequence: COLOR NEEDS is EMPTY — this whole surface needed no new token.**
2. **The card border is `--pn-line`, not the oracle's `#2C2719`.** `#2C2719` is the *dark* `--pn-line`; the oracle uses it because the cards sit on a dark review stage. D47 precedent: the stage is canvas furniture. Product frames are full-bleed and their edges invert.
3. **The affirmatives on this canvas are BRASS, not the D58.1 ink chip.** D58.1 rules `.lp__new` ink on T0-1; this canvas paints `＋ Invite`, `Save menu`, `Create invite link` brass (L49/L288/L104). A surface answers to its own oracle — the sheet-commit-button lesson. The one ink control here is the redeem CTA (L133), and it uses D58.1's `--pn-x-btn-ink-hover`.
4. **Refusal skin: same treatment, two skins.** `set-refuse--block` and `set-refuse--ink` change WIDTH and FILL of `hon-disabled--inline` and nothing else — the aria-disabled, the focusability, the reason-in-the-DOM and the `.45` are honesty.css's verbatim. Precedent and argument: `src/auth/HANDOVER-Auth.md` §2.1. **This is not a fourth treatment**, but "same treatment, different skin" is the claim that should be ratified rather than assumed.
5. **Member removal is refused even though `deleteEntity` exists.** Deleting the member ENTITY is not the same act as revoking space membership. Wiring the first to a control labelled the second invents a semantic on a destructive path. Refused, with the reason saying exactly that. **This is the ruling most worth reversing if you disagree** — it is the only place I declined an available executor.
6. **The handle is HOLLOW for everyone but the viewer.** The oracle draws `Ada Osei @ada`; `EntitySummary` carries no username. `@—` with a T1-4 caption, never `@` + a slugged title.
7. **The oracle's ROLES legend names four roles; `EntityState` has three.** The legend ships verbatim (it is the oracle's copy) with a footnote stating `viewer` is not representable in this build. Surfaced, not reconciled.
8. **The editor's validator IS the rail's validator.** `draftIssue()` runs the draft through `resolveMenu`. The cap constants exist only so a disabled control can state its number, and `menu-edit.test.ts` asserts each sits exactly where `resolveMenu` flips. A duplicated magic number would have drifted silently, and the drift would present as "I saved a menu and the rail ignored it".
9. **Reorder is keyboard-reachable (alt+↑/↓ on the grip), which the oracle does not draw.** A reorder that only exists under a mouse is a control a keyboard user can see and never use — the same argument that makes the refusal treatment focusable.
10. **D63's two-row panel chrome does NOT bind here.** T2 draws full-view surfaces, not detail panels. Stated so nobody reads its absence as drift.

### DRIFT (accepted, deliberately not chased under "fidelity later")

- Product frames are full-bleed; the oracle's `1264px` stage, `470px` / `460px` fixed card heights and `640/262/298/470/220px` column widths are review-board furniture (D47). The 160px nav column and all card/row geometry ARE transcribed.
- The `<sc-if notes>` annotation badges (the ①②③ circles) are canvas apparatus and are not built.
- The rename caret is the oracle's hand-drawn 1.5px brand bar; the build uses a real focused input and lets the browser draw the caret.

---

## 3. COLOR NEEDS

**None.** Every hex the oracle paints on T2-1 and T2-3 already exists as a token. Full mapping is in the header comment of `settings.css`. Two tints are DERIVED rather than restated and say so in place: the pending-row `rgba(162,156,142,.06)` (`color-mix` off `--pn-idle-soft`, which is the same colour at `.16`), and the info/wait border alphas (`color-mix … 40%`).

---

## 4. GAPS — capabilities that do not exist

Each of these is a REASON in `reasons.ts` and a refused control on screen. Split by remedy, because the two halves need different people:

**Needs a SEAM AMENDMENT (the contract already has the DTO):**
- `spaces.menu.update` — `UpdateMenuInput` with `expectedRevision` exists in `@tm8/contract`; `data/seam.ts`'s own header records the ruling that it "stays OUT of this seam until their phase; adding either is a deferred amendment requiring dual re-consensus". **This is the single largest gap in half A**: the entire menu editor is real and its commit verb is unreachable. The conflict and version-lock states are contract-real for the same reason, which is why they were built rather than skipped.

**Needs a SERVER/CONTRACT CAPABILITY (nothing exists to wire):**
- Invites, entirely — no read, no command, no DTO. Searched both on 2026-07-29.
- Member role change — `PatchEntityInput` is `{expectedVersion, title?, content?}`; role lives in state.
- Space membership revocation — no membership verb of any kind.
- Space profile mutation, ownership transfer, space deletion.
- Task-axis definition — `CollectionQuery` *consumes* axes; nothing *defines* the axis set for a space.
- A username on `EntitySummary` (see §2.6).

---

## 5. Files + diffstat

All new, all under `packages/tm8-ui/src/settings-space/`. **Nothing modified anywhere.**

```
 MenuEditor.tsx           697 ++  T2-3 editor + preview + conflict + version-lock
 settings.css             666 ++  the whole grammar, tokens only, every value citing its oracle line
 settings.test.tsx        426 ++  31 tests, incl. the two class-level sweeps
 menu-edit.ts             322 ++  the editor model; validator IS resolveMenu
 SettingsShell.tsx        284 ++  T2-1a nav + section host + slot registry for half B
 menu-edit.test.ts        245 ++  20 tests, caps cross-checked against the rail
 InviteFrames.tsx         239 ++  T2-1c invites + T2-1d redeem (4 states)
 reasons.ts               192 ++  the GAP ledger in code — 18 reasons, one read
 port.ts                  158 ++  the ONE seam adapter; registry-derived kind + role words
 no-kind-literals.test.ts 153 ++  this lane's §15.2 + §14 guard (D62 §3)
 MembersSection.tsx       150 ++  T2-1b
 SettingsBoard.tsx        116 ++  dev-only: every frame × 2 themes
 specimen.ts              113 ++  the oracle's strings, named so nobody mistakes them for data
 port-seam.test.tsx       110 ++  7 tests — THE test in the gap, against a real fixture seam
 types.ts                  92 ++  props contract + the 8-section table
 index.ts                  72 ++  public face; imports its own CSS so no host edit is needed
 16 files, 4035 lines
```

**Dirty in the tree that is NOT mine** (stated rather than assumed known): `src/terminal/index.ts` and `src/terminal/terminal.css` modified (Track P); untracked `src/auth/`, `src/authoring/`, `src/home/` (other seats — `src/auth/index.ts` gained an `AuthGate` export mid-session while I worked); and 15 `scratch-p*` files at the package root. None caused by me, none needing action.

---

## 6. Red-first record

**menu-edit** — the model, red before it existed:
```
FAIL src/settings-space/menu-edit.test.ts
Error: Cannot find module './menu-edit' imported from …/menu-edit.test.ts
Test Files 1 failed (1) · 04:07:05
```
→ after `menu-edit.ts`: `Test Files 1 passed (1) · Tests 20 passed (20)` at 04:08:35.

**Two tests found real defects rather than confirming work** (recorded because a green that was never red is a claim):

1. *"the version-locked state makes the whole editor read-only"* went red on the first run: `'＋ add child' is still live under a version lock: expected false to be true`. `canAddChild` was missing the `editable` term — every other control obeyed the lock and one did not, which is exactly the shape of defect a per-control eyeball never finds. Fixed in `MenuEditor.tsx`, comment kept in place.
2. This lane's own §15.2 guard fired on its **first execution**: `specimen.ts → 'member'` and `InviteFrames.tsx → 'member'`. The finding is more interesting than a style nit — **the least-privileged role word and the member KIND are the same string**, so a hard-coded `'member'` role is indistinguishable from a kind-literal violation to any scanner *and to any reader*. Resolved by deriving both from one registry table (`memberKindRef()` / `memberRoles()` / `ownerRoleRef()` off the member row's `chip.tintBy` and `chip.tones`) rather than by exempting the file. `ownerRoleRef()` also drives the owner lock, so no `=== 'owner'` exists either — asserted by a fourth guard case.

Two further reds were **test imprecision, not product defects**, and were fixed in the tests with the reason recorded in place: a `/owner/` matcher that also matched the refusal reason, and a `/node/` matcher that also matched "your account on this node".

---

## 7. Wide check — timestamp · scope · instrument

- **Instrument:** `bunx vitest run --exclude 'src/terminal/**'` from `packages/tm8-ui`. Banner control: `RUN v4.1.10 /Users/subhang/Desktop/Projects/tm8/packages/tm8-ui` — the v4 tree with the v4 runner, never the repo root.
- **Scope:** whole package minus `src/terminal/**`. Includes the other seats' in-flight `auth/`, `authoring/`, `home/`.
- **Result, 2026-07-29 04:24 local:** `Test Files 56 passed (56) · Tests 1067 passed (1067)`. Zero failures.
- **`bunx tsc --noEmit` from `packages/tm8-ui`, same window: clean, no output.** (It caught one real thing on the way: `.at(-1)` is TS2550 against this lib target — replaced with index arithmetic, comment kept.)
- My lane alone: `Test Files 4 passed (4) · Tests 66 passed (66)`.

---

## 8. INTEGRATION NOTE — exactly how to wire this

Nothing here is mounted. `index.ts` imports its own stylesheets, so **no host file needs a CSS edit.**

### The product mount

```tsx
import { SettingsShell, settingsPortFromSeam } from '../settings-space';

// `seam` is the Seam the gate already constructed; `spaceId` the active space.
const port = useMemo(() => settingsPortFromSeam(seam, spaceId), [seam, spaceId]);

<SettingsShell port={port} />
```

**Exact props** (`SettingsShellProps`, `types.ts`):

| prop | type | required | notes |
|---|---|---|---|
| `port` | `SettingsPort` | ✅ | build with `settingsPortFromSeam(seam, spaceId)`. The shell re-reads whenever this identity changes — **memoise it**, or it refetches every render. |
| `sections` | `Partial<Record<SettingsSectionId, ReactNode>>` | — | half B's bodies. Anything supplied wins over my placeholder. |
| `initialSection` | `SettingsSectionId` | — | defaults `'members'` (the oracle's own drawn state). |
| `onSectionChange` | `(id) => void` | — | mirror into the route if you want deep links. |

`SettingsSectionId = 'profile' | 'members' | 'invites' | 'axes' | 'projects' | 'menu' | 'kinds' | 'danger'`.

### Expected mount point

The shipped default menu already carries `{ type: 'view', ref: 'settings' }` in its own `settings` group (`domain/menu.ts`), and `VIEW_PRESENTATION.settings` gives it `⛭ Settings`. So the rail row **already exists and already routes** — the shell just needs a destination. Mount `SettingsShell` wherever the `settings` view ref resolves to a full view (it is a full view, not a panel: oracle L24, "a full view (menu › Settings)"). It fills its container; it sets no viewport height of its own, so D63.3's vh-under-zoom law is not in play here.

### Meeting half B

Half B builds `Linked projects` (T2-2) and `Custom kinds` (T2-5). Pass them in:

```tsx
<SettingsShell port={port} sections={{ projects: <TrustSection … />, kinds: <CustomKindsSection … /> }} />
```

Neither lane imports the other. Unmounted, those two rows render disabled-with-reason naming the gap — never a blank pane.

### Standalone frames

`MembersSection`, `InvitesPanel`, `RedeemLanding`, `MenuEditor` are each exported and mountable alone. **`RedeemLanding` is the one a stranger sees** — it takes no port and reads nothing, so it can be mounted on an unauthenticated route safely. It renders only the facts you hand it; omit `memberCount` / `nodeName` and it omits them rather than guessing.

### Dev review board

`SettingsBoard` renders every frame in both themes with the oracle's strings. Never product — mount it beside `AuthBoard`/`GalleryPage`.

### D-entries I am authoring (send text; I never stage `DECISIONS.md`)

- **The kind/role string collision.** A registry row's role vocabulary can share a string with a kind, so §15.2's scanner cannot distinguish them — and neither can a reader. The fix is to derive both from one registry table, never to exempt the file. Found by this lane's guard on its first execution.
- **An editor's validator should BE the renderer's validator.** Restating a consumer's limits creates constants that drift silently and present as "I saved it and it was ignored". `draftIssue()` → `resolveMenu`.
- **Ratification asked for** on §2.4 (the two refusal skins) and §2.5 (declining an available `deleteEntity`).

---

## 9. NOT CHECKED — said plainly

1. **I never looked at it.** No browser, no `:4612`, no screenshots — the directive says the user reviews live after the coordinator wires. So **every layout claim in this document is a jsdom claim.** Brief §4.4 exists because jsdom cannot see layout: a percentage height that never resolves, a clipped label, an off-screen section all pass "the element exists". Specifically unverified: the `set-menu` three-column wrap at real widths, whether the editor and preview columns actually reach equal height, whether the 160px nav clips a long space name, and both themes at all.
2. **Dark theme is asserted only by construction** (tokens throughout, no per-theme override written). Nobody has rendered it.
3. **The real seam.** Everything is proved against `createFixtureSeam()`. `createRealSeam()` returns the same contract DTOs by design (LLD C-3), but I did not run against a live node, and on fixtures `menu()` resolves null — so **the `origin.source === 'server'` path of the editor has never executed.** A space with a stored menu is the untested case, and the preview footer line for it is unexercised.
4. **Drag-and-drop is HTML5 dnd and was tested only via the keyboard path.** jsdom does not carry a real DataTransfer; the mouse reorder is unwitnessed. The keyboard path is fully asserted.
5. **The conflict state's trigger.** I render it when a host passes `conflictRevision`; **no host does yet.** Wiring it to a `menu.updated` event is a host job I did not do, and `DurableWorkspaceEvent` does carry `{ type: 'menu.updated', menu, clientMutationId }` — so the wire exists and is unbuilt.
6. **`versionLocked` is a prop, not a derivation.** `resolveMenu` distinguishes `future-version`, but I did not wire that to the lock, because the read path collapses to the shipped default in that case and the editor would then be locking a config it is not showing. Named rather than guessed.
7. **Half B's frames.** I enumerated T2-2/T2-4/T2-5 from the oracle and read none of them in depth.
8. **The 40-character floor** in the no-dead-nav test is a threshold I chose, not a measurement. It catches a blank pane; it would not catch a body that renders one honest sentence where a real section belongs.
