# Lane D — Authority conflict, draft D76, and the adversarial review

**Status:** analysis only. Nothing here is a ruling. D76 below is a DRAFT for Subhang/Tarkesh; it is
deliberately NOT appended to `packages/tm8-ui/DECISIONS.md`.
**Author:** Lane D worker, 2026-08-26. Branch `docs/lane-d-authority-review` off `origin/main` @ `b5da1220`.
**Evidence base:** the v19 prototype (sha256 `eb0c3096…f5cd`, 309,437 bytes, 2,218 lines — hash re-verified
by this lane), `packages/tm8-ui/LLD.md` + `DECISIONS.md` (D1–D75), `docs/ui/orchestration/CHARTER.md`,
`docs/architecture/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` (WLT v2.11), `packages/contract/src/schemas.ts`,
`packages/tm8-ui/src/**`, the plan artifact `01a03e78-cc00-764b-a8e2-6cf1bc8b1f2b`, and the brief doc
`01a03e7b-0ee0-7e6a-a314-8ecad50a35d4`. Prototype line numbers below refer to the file at the attached
blob (identical to what Deliverable A will land as `tm8-product-v19.dc.html`).

**The missing authority, confirmed independently.** The prototype's header comment (line 10) says it is
*"built on DESIGN.md v1.2 … (Stitch design-md format)"*. This lane searched the repo (`find`/`grep` over
the worktree at `b5da1220`), `/home/tm8/prod-workspace/designs/`, and every `*design*.md` under
`~/projects` and `~/prod-workspace`: **no Stitch-format DESIGN.md exists anywhere reachable**. The only
`DESIGN.md` in the repo is `docs/features/dreamer-dispatcher/DESIGN.md` — an unrelated feature design
(status: "DESIGN AGREED … Not implemented"), notable separately because it is the closest thing
Dispatcher/Dreamer have to real backing. The prototype's cited authority is **not in evidence**. Every
"the prototype intends X" claim in this program is therefore reverse-engineered from CSS and demo script,
and D76 must treat the prototype as an *exhibit*, not an *authority*.

---

## 1 · Conflict list — where the prototype contradicts the standing chain

The standing chain (LLD.md line 5, highest first): CHARTER rulings → `DECISIONS.md` (the FILE is the
ledger authority) → WLT v2.11 → `TM8-UI-SPEC-FINAL.md` → 01-REQ/02-LAYOUT/03-ATELIER → round-2 canvases.
The ten laws cited are LLD.md §0.

One caveat the ruling needs to hold in mind: **the chain itself has measurable drift** (see the D76
measurement table) — the LLD's kind count and canvas count are stale against the tree. Conflicts below are
judged against the chain *as corrected by the ledger and the contract*, which is what the chain's own
"the FILE is the ledger authority — re-read it at every audit point" clause demands.

| # | What the prototype does (evidence) | What the chain says | Law / ruling touched | Recommendation |
|---|---|---|---|---|
| C-1 | **Kind logic is inline branches everywhere.** `entKind()` switches on eid prefix (line 1523); `openEnt()` is an if-chain over `ses/tm/task/conv/proj/mem/pr/rel/wt/loop` prefixes (1649–1660); `EID2DOC` is a hard-coded kind map (1648). | A per-kind behavior with no registry field is a spec defect; kind literals are banned outside `src/domain/` (enforced by lint + `registry.test.ts`). | **L2** | Adopt *ideas*, never mechanics. Any adopted screen re-expresses per-kind divergence as `KindConfig` fields. The prototype's JS is disqualified as an implementation reference. |
| C-2 | **12 bespoke pages + 21 bespoke sheets, zero shared primitives.** Every list (`renderTasks`, `renderSesList`, `renderEnts`, `renderLists`) and every detail (`sh-task`, `sh-ses`, `sh-mate`, `sh-doc`…) is hand-rolled markup. | Two primitives carry every list and every detail; six collection layouts behind one switcher. | **L3**, C4/C5 | New surface content lands as ListConfig/PanelConfig data, content blocks, or (rarely) a new archetype — decision-logged. Thirteen bespoke pages would fork the router and re-create the codebase `packages/ui` was retired for. |
| C-3 | **No URLs at all.** `go()` toggles CSS classes (1293–1306); no hash, no history, no codec; reload lands on the splash. Sheets are unaddressable. | Everything navigational is a URL; one codec; share/reload lands looking right. | **L8**, WLT §2.2 | Every adopted destination must resolve through the existing route grammar. Sheets that carry entity detail (task, session, doc) must be reachable as `e/{id}` panel state, not ephemeral overlays. |
| C-4 | **Ghost affordances are the demo's fabric.** `provision()` prints fake setup steps ("Trust gate created", "Snapshot taken — your undo point", 1439–1456); `termLogin()` is a scripted fake terminal (1425–1438); voice input "transcribes" a hard-coded string (1797–1806); dozens of buttons `toast()` a marketing sentence instead of acting ("Pipeline saved — pol·pipe-2", 992). | Unavailable ≠ invisible: a UI may never advertise an action the facade cannot perform; `no-op-handler-ban.test.ts` exists because this class already burned the codebase. | **L6**, R7 | Fine in a sales artefact; disqualifying in the product. Anything adopted ships wired to a seam op or renders disabled-with-reason. No fixture-only screens (already the parent plan's rule — hold it hard). |
| C-5 | **One-badge status everywhere.** Session state is a single pill from `SM` (working/waiting/done/ready, 1487); "Completed · verified" merges record and verification into one badge; liveness dots are scripted, yet the copy claims "state is provider-verified — never inferred from silence" (1495). DM sends claim "lands in their inbox as attention" with no delivery facet. | Honesty states never collapse: liveness exclusively from `seam.liveness.statusOf`; delivery renders as two facets, never one badge; `unknown` never renders live. | **L7**, R-UI-5, WLT §5.7 | Adopt the prototype's *visual* pill language if ruled, but the state vocabulary underneath is non-negotiable: two facets for delivery, four-valued liveness, no "verified" wording without a verifying read. The copy "provider-verified" may only ship where the seam actually provides verification. |
| C-6 | **Undo is a hero feature.** One-tap `Undo` on a live release (2127, 2161–2175), "⟲ Checkpoint saved · restore to before rel·ao-1" (2126), an "Undo on trouble" auto-rollback switch in Admin (830), "Snapshot taken — your undo point" during local-folder provisioning. | R7 defers undo program-wide (render disabled-with-reason, never built); the drop grammar's row 8 explicitly promises **no undo** and states irreversibility in its copy. | **R7, L6**, §8 of LLD | **Strongest single conflict in the file.** Do not adopt any undo/checkpoint affordance without a contract-backed rollback design (that is a Layer C backend project, not pixels). Until then the prototype's undo moments are the textbook ghost affordance. |
| C-7 | **All avatars are circles.** CSS `.av{border-radius:50%}` for humans, agents, and harness alike; agents get colour-coded circles (`.av.claude`, `.av.dispatch` gradients). | Agents are peers **with provenance**: round vs rounded-square avatars distinguish human from agent by shape, not colour alone. | **L10**, C8/C9, ATELIER | Keep the shipped shape distinction. Colour-only actor identity also fails the colour+word discipline for anyone colour-blind. The prototype's persona colour system, if adopted, layers *on top of* the shape rule. |
| C-8 | **Status is sometimes colour-only.** Naked dots with no word: Dispatcher's `dot g live` (713), pulse-sheet session dots (919–924), the task strip dot (614). Mostly the prototype does colour+word pills — the dots are the exceptions. | Status is always colour + word. | **L10** | Trivial to fix at adoption time; listed so it isn't silently inherited. |
| C-9 | **Eight chromatic tokens named by colour, plus ~10 bespoke persona hexes.** `--blue --green --orange --red --purple --teal --pink --indigo` + tints (lines 15–45), avatar hexes `#8E6E4E #0E9B8A #B04AC4 #3A3A3C` and three gradients (dispatch/dreamer/you). | ATELIER: ONE brand accent (`--pn-brand` brass) + a semantically named status ramp (`--pn-run/wait/block/info/idle`), guarded by `hex-ban.test.ts` and `tokens-verbatim.test.ts`. | ATELIER, L10, D-ledger token discipline | The plan's "value swap inside an existing token vocabulary" is **false for this slice** (see review §3.2). Colour-named tokens must not enter `tokens.css`; persona colours, if wanted, need a designed, semantically named actor-palette — a D-entry of its own. |
| C-10 | **A hard-coded 9-state task machine.** `TSTATES = open→claim→pulled→start→working→submit→in_review→complete→done` plus `changes` (1548–1550), rendered as a fixed rail in the task sheet. | Task status is a per-space vocabulary (`task_workflows` in the contract, `spaces` DTO); WLT workStatus; L2 says per-kind/status divergence is data. | **L2**, contract §3541 | Mine the *rail rendering* (nice), reject the fixed vocabulary. Any stage rail renders the space's workflow data. |
| C-11 | **The SDLC stage pipeline with owners and gates** (`STAGES`/`STG`, 1102–1123; `sh-pipe` "Saved per project · versioned as policy"). | No such concept exists in the contract; nearest is `task_workflows`, a status vocabulary, not an ordered gated stage machine. | Layer C; **L6** if shipped as pixels | Contract-first, exactly as the plan's Wave 5 says. Add: the pipeline's *gate = attention request* idea maps to the REAL attention-request feature — that mapping is worth a design doc even if stages are dropped. |
| C-12 | **Invented entity kinds on screen:** `rel·` release (1239), `pol·` policy (795, 992), `ws·` working set (1500), `lr·` launch record (1504), `run·` harness run (713–714), `att·` attention as eid (1892), `list·` (1834). | `CoreEntityKindSchema` (measured at `b5da1220`) has 21 kinds; none of these are among them. `att` exists as attention *requests* (a subresource, not an entity kind); `lr`/`ws` are work_session facts, not entities. | WLT §2.1 totality, **L2** | Per concept: map to existing state where it exists (cost, transcripts, launch provenance are real `work_session` facts), contract-design the rest, drop `pol·` until policies exist. Never render an eid chip for a kind the registry can't resolve — chips are navigation (L8) and a dead chip is a ghost (L6). |
| C-13 | **Terminology drift.** "Workspaces — org and personal side by side, switch like accounts" (`sh-spaces`, 1022–1027) while the auth flow says "Choose your space"; the project page says "humans on this server". | WLT v2.8 RULING I: the root noun is `Server`; the container noun in product language is `space` (hubspace retired). The shipped UI says Space. | WLT RULING I | Adopt "space" everywhere; the prototype's own inconsistency shows it was never terminology-reviewed. The org/personal *switcher concept* itself is fine — spaces already model it. |
| C-14 | **A second terminal.** The `sh-term` sheet fakes PTY output with `setTimeout` lines; "Attach terminal" promises live PTY attach, read-only takeover (978). | The terminal stack is a verbatim transplant and a black box (R9); one pool, one host law; no second implementation. | **L5/R9** | Model sign-in *flow* (device-code login rendered in a terminal surface) is a genuinely good idea — route it through the real transplant host, never a lookalike div. "Attach to live PTY read-only" is an unshipped feature: disabled-with-reason or nothing. |
| C-15 | **Navigation shape: 10-item rail, 5-slot phone tab bar + More sheet** (570–585, 839–845), with Chat/Sessions/Team/Knowledge/Tools/Insights/Admin as top-level peers; Lists exists only inside More. | Shipped default `MenuConfig` (revision 20): Home/Work/Craft/Graph/Settings/Help with kind leaves; menu is RULING-H server data with fail-closed versioning; phone tabs derive from the registry (`views/MobileShell.tsx`, `no-router-fork.test.ts`, `shell-contract.test.ts`). | RULING H, L2, L8 | This is the real per-layer decision D76 exists for. If prototype IA wins, it enters as menu DATA + a shipped-default revision bump — and only destinations that resolve to real views ship enabled (see review §3.4 — today 3–4 of the 10 would be stubs). |
| C-16 | **Six-hue "one voltage".** The file's own comment claims one brand voltage (tm8 indigo), but interactive accents use blue/indigo interchangeably plus per-provider colours throughout. | ATELIER's actual one-accent discipline (brass), enforced by tests; Q2 (brass vs indigo) is an open brand call. | ATELIER, Q2 | The brand call is genuinely open (Q2, Subhang/Tarkesh). What is NOT open: the count. One accent, whichever hue wins. |
| C-17 | **Fixed-position graph canvas with hand-placed nodes** (`GNODES` x/y literals, 1226–1243) revealed by scripted `beat()`s. | Graph surfaces exist in the product (`src/graph/`, `graph` kind, session-graph) with real layout; canvases are pixel ground truth, not data. | L3, D-ledger graph track | Mine the *story* (provenance chain as the demo's spine is the product's best pitch); the implementation is pure theatre. |
| C-18 | **Auth/onboarding flow** (splash → email/SSO → space pick → GitHub+model connect, 530–567) with fake SSO buttons that all `authGo(2)`. | Real `auth/`, `join/`, `account/` modules exist; D74 rules sign-out address semantics precisely. | D74, L6 | The 3-step onboarding *shape* is good product thinking the plan ignored (review §3.5). Flow mechanics must respect D74 (the prototype's `logOut()` keeps everything warm — that is exactly the pre-D74 bug). |

---

## 2 · Draft D76 — which authority governs when the v19 prototype and WLT v2.11 disagree

> **DRAFT — for the ledger only after Subhang or Tarkesh rules. This lane does not decide.**
> House style follows D73/D74/D75: source, what is wrong, measurement, ruling, what is NOT ruled,
> rationale, lesson.

### D76 — SUPERSEDES nothing yet: the v19 prototype is an exhibit, not an authority; per-layer governance when it disagrees with WLT v2.11 (2026-08-26, DRAFT)

**Source.** Tarkesh, 2026-08-26: *"check for tm8 repo and make sure these prototype design and design
are adopted"* — plus the prototype file itself, whose header claims descent from *"DESIGN.md v1.2 …
(Stitch design-md format)"*, a document that is not in the repo, not in the Space, and not on this
machine (searched by two independent lanes: the plan author and Lane D).

**What is wrong.** Two documents now behave as design authorities and they cannot both be right. The
standing chain (LLD.md line 5) was adjudicated over twelve review rounds and is enforced by tests; the
prototype arrived with no traceable authority, contradicts the chain in eighteen measured places
(§1 above), and — because it is beautiful and complete-looking — is already exerting gravity: an
adoption plan, a 4-lane analysis wave, and a proposed re-theme all assume it wins somewhere. An
assumption is not a ruling. Meanwhile the standing chain has its own drift, so "the chain wins,
full stop" would also ratify errors.

**Measurement — both authorities fail a spot-audit, in different ways:**

| Claim | Claimant | Measured at `b5da1220` | Verdict |
|---|---|---|---|
| "13 `.page` screens" | plan artifact §2 | `grep -c '<section class="page'` → **12** | wrong |
| "18 canvases in round-2" | LLD.md line 5; CHARTER | `ls *.dc.html` → **20** | stale |
| "21 hi-fi canvases" | plan artifact §5 W1 | 20 | wrong |
| "15 kinds" in the registry exhaustiveness law | LLD.md §2 | `CoreEntityKindSchema` → **21** (`voice_channel memory worktree artifact loop graph` added) | stale |
| "user rulings R1–R15" | LLD.md line 5 | CHARTER contains **R1–R17** | stale |
| "one brand voltage" | prototype header | 8 chromatic tokens + ~10 persona hexes + 3 gradients | wrong |
| "built on DESIGN.md v1.2" | prototype header | file not found anywhere | unverifiable |
| "8pt grid" | prototype header | spacing scale `2,4,8,12,16,24,32,40` | marketing |

The prototype's errors are *fabrications* (claims about itself and about product capability that are
untrue). The chain's errors are *staleness* (counts that were right in July). These are different
failure modes and they get different treatment: staleness is repaired by re-measuring; fabrication
disqualifies the document as an authority while leaving it valuable as an exhibit.

**The ruling (proposed), per layer:**

1. **Theme (tokens, type, radius, shadow).** *Neither wins by default; the ledger arbitrates.* The
   prototype supplies candidate VALUES only, filtered through ATELIER's VOCABULARY: one accent
   (hue = Q2, a brand call reserved to Subhang/Tarkesh), semantic status names, no colour-named
   tokens, no per-provider hexes in `tokens.css`. The `tokens-verbatim` byte-equality guard survives
   any swap; every changed value is one Lane-A-table row with a D-entry. The persona colour system is
   NOT part of the theme layer — if wanted it is a new, designed actor-palette decision.
2. **IA (rail, tab bar, destinations).** *Prototype proposes; WLT mechanics dispose.* The 10-item
   rail and 5+More phone bar may be adopted **only** as `MenuConfig`/registry data under RULING H,
   with a shipped-default revision bump, and only destinations resolving to existing views ship
   enabled; the rest render disabled-with-reason or stay out of the default. No new router, no
   bespoke pages (L2/L3/L8 are not up for adoption).
3. **Component mechanics (panels, lists, keyboard, terminal, floors).** *WLT + ledger win outright.*
   The prototype has no mechanics to adopt — no URLs, no primitives, no keyboard contract, a fake
   terminal. Nothing in this layer is governed by the prototype under any outcome.
4. **Honesty rules (L6/L7/L10 vocabulary).** *Not adjudicable — these are standing user rulings.*
   No exhibit can relax them; conflicts C-4/C-5/C-6/C-7/C-8 are defects in the prototype, full stop.
   In particular the release-Undo hero moment stays out until a rollback contract exists.
5. **New concepts (stages, personas, releases, spend caps, policies, pulse).** *Neither the prototype
   nor WLT governs — the contract does, and it is silent.* Each concept enters through a design doc
   and an additive contract decision (charter R4) before any pixel. The prototype is the requirements
   *input* to those docs; WLT constrains their eventual UI expression.

**What is NOT ruled by this entry.** Q2 (brass vs indigo) — reserved, brand. Q4 (phone-first vs
desktop-first) — reserved, and it materially changes wave order. Whether any specific wave is
approved — that is the plan's approval, not this entry. The disposition of `DESIGN.md v1.2` if it
later appears — a new entry re-opens per-layer questions with the actual document in evidence; its
non-appearance by then is itself evidence. Repair of the measured LLD staleness (kind count, canvas
count, R-range) — that is a separate hygiene D-entry, listed here only as measurement.

**Rationale.** The chain earned its authority through adversarial process and enforcement; the
prototype earned attention through quality of vision. Those are different currencies. Adopting vision
through governed channels is exactly what the ledger is FOR — D73 and D75 both show the process
absorbing outside truth without surrendering to it. And the exhibit-not-authority framing resolves
the "which document wins" question without ever needing the missing DESIGN.md: exhibits don't win,
they persuade rulings.

**The lesson.** An artefact that cites an authority nobody can produce must be treated as
self-authored. The header said "built on DESIGN.md v1.2" and every reader downstream repeated it as
provenance; two searches later it is an unfalsifiable claim wearing a version number. Provenance that
cannot be fetched is not provenance — the same law this codebase already applies to liveness
(verified, never inferred) applies to design documents.

---

## 3 · The adversarial review — the case against the plan

The plan is good work: honest about Layer C, right about the guard tests, right to gate waves on a
ruling. The case below is where it is still wrong, ordered by how much each finding should change it.

### 3.1 · The "70% of screens already have a home" claim is unsupported at its own granularity, and the number measures the wrong thing

**Falsified as stated.** The plan says "13 screens"; the file contains **12** `<section class="page">`
elements (the 13th grep hit is the `.pages` container — an error that itself shows the count was never
verified). Its companion claim "16 of the ~20 entity types it invents already exist as real contract
kinds" also fails measurement: the prototype uses ~20 eid prefixes (`conv task doc art plan wt pr rel
loop mem ses tm proj ws lr att pol run list sha`); mapping against the 21-kind enum, **12–13** map
cleanly (task, doc, art→artifact, wt→worktree, pr, loop, mem→memory, ses→work_session,
tm→team_member, proj, list→collection, conv→channel approximately, plan→doc). Seven do not: `rel`,
`ws`, `lr`, `pol`, `run`, `sha` (a property, not an entity), and `att` (a real *subresource* —
attention requests — but not an entity kind). 12–13 of 20 is 60–65%, not 80%.

**More generous is more wrong.** The 70% figure counts a screen as "homed" because a directory exists
(`loops/`, `servers/`, `settings-governance/` — all real, verified by this lane). But the plan's own
Fit column already concedes 4 of 12 pages are "Partial", and at *sheet* granularity the homeless set
concentrates exactly where the demo's persuasive power is: `sh-pipe`, `sh-stage` (stage machine — no
contract), `sh-pulse` (live journey/spend dashboard — no backing), `sh-ledger` (self-critique theatre —
must never ship), the Insights compliance block, the Admin gates block, the spend meters. Weight the
inventory by *build cost* or by *demo minutes* instead of by screen count and the majority of what
Tarkesh saw when he said "adopt this" has **no home**. The honest sentence is: *"~60% of surfaces by
count map to existing modules; the remaining ~40% contains nearly everything that makes the demo
compelling."* That sentence changes what "adopt the prototype" means, and the plan should say it.

### 3.2 · Wave 2 is not a "value swap", and calling it fully reversible papers over a design-language decision

The plan: Layer A is "a value swap inside an existing token vocabulary … The real work is the mapping
table." Measured, the vocabularies are disjoint in the places that matter:

- ATELIER: **one** accent (`--pn-brand` brass) + a **semantically named** muted status ramp
  (`--pn-run/-wait/-block/-info/-idle`, `--pn-pr-merged`) — 175 lines, semantic names enforced in
  spirit by `hex-ban`.
- Prototype: **eight colour-named chromatic tokens** (`--blue --green --orange --red --purple --teal
  --pink --indigo`) + tint variants + ~10 raw persona hexes + 3 gradients, with `--blue` serving
  simultaneously as brand, info, working-status, and one persona's colour.

There is no value-level mapping from 8-and-colour-named onto 6-and-semantically-named; someone must
decide which prototype colours *die* (purple/teal/pink have no ATELIER slot), whether status hues
brighten toward the prototype's ramp, and whether persona colouring exists at all. Those are design
decisions wearing a sed script. "Revert one file" is true for the CSS and false for the decisions —
a re-theme that ships to users and is then reverted is not reversible in the sense that matters.
**Change:** Wave 2's brief must enumerate the vocabulary collisions (Lane A's four-way table is the
right vehicle) and put the kill-list of prototype-only tokens INTO the D-entry, not leave it to the
worker's taste. And Wave 2 stays blocked on Q2 — which the plan says — but also on the persona-palette
question, which it never names.

### 3.3 · The prototype's undo story is a standing-ruling violation the plan never flags

The plan's Layer C table catches spend caps as an L6 hazard but is silent on the demo's single most
repeated promise: **rollback**. One-tap Undo of a live release, "Checkpoint saved · restore to before
rel·ao-1", an Admin "Undo on trouble" auto-rollback switch, "Snapshot taken — your undo point" during
provisioning. R7 defers undo program-wide; the LLD's drop grammar goes further and rules copy must
state irreversibility. A casual reader of the plan could approve Waves 1–3 and still believe the undo
moments are part of "the last 30%" backlog; they are not — they are *ruled out* until a rollback
contract exists, and the tour builds its emotional climax on them ("Undone. Nobody noticed."). The
consolidated adoption doc needs a "ruled-out-as-shown" list, with undo at the top, so nobody prices
Wave 5 with it silently included. This is the difference between "not built yet" and "promised and
forbidden" — L6's exact concern.

### 3.4 · Wave 3 as scoped would ship a rail of stubs — "IA as registry data" is necessary but not sufficient

The plan is right that the IA must be menu/registry data (the derived-tab-bar law is real —
`views/MobileShell.tsx`, `no-router-fork.test.ts` both exist). But walk the 10 rail items against the
tree: **Insights** has no view (loops exist; the spend/compliance/audit dashboard does not),
**Tools** beyond MCP `servers/` has no view (Slack/Jira/SAP connectors are fixtures), **Admin**
conflates three settings modules plus unbuilt gates config, and **Sessions** as a top-level *per-
conversation* grouping (what the prototype actually draws, lines 706–719: "This conversation" +
harness) matches no existing list config. So the honest Wave-3 outcome under L6 is a 10-item rail
with 3–4 disabled-with-reason rows in the shipped default — legal, and bad. A default menu is the
product's face; a face of stubs tells every user "this app is mostly not built". **Change:** split
Wave 3 into 3a (adopt the rail *shape* for destinations that resolve today: Home, Chat, Sessions-as-
list, Projects, Graph, Team, Knowledge) and 3b (add Insights/Tools/Admin rows only when their views
land in Wave 4/5). Also note Wave 3's real blast radius: the shipped default is versioned
(`SHIPPED_DEFAULT_MENU_REVISION = 20`) with fail-closed semantics — "one file" is accurate but the
revision bump and menu-editor interaction deserve a line in the brief.

### 3.5 · What the plan missed entirely

- **The auth/onboarding flow.** Lines 530–567 are a designed 3-step onboarding (email/SSO → space
  choice → "Two connections": GitHub + model sign-in) plus splash and sign-out. The plan's screen
  inventory starts at `pg-home` and never mentions it, yet `auth/`, `join/`, `account/`,
  `settings-credentials/` all exist and D74 already rules part of this surface. The prototype's
  onboarding is arguably its most directly adoptable screen cluster — real modules, real flow, low
  conflict. Missing from all five waves.
- **Voice input.** The composer has a full voice-capture UI with fake transcription (654,
  1797–1806). Product question (do we want it? which STT? on-device?) — never named, so it will
  silently reappear every time someone opens the prototype.
- **The gate = attention-request mapping.** The demo's gates (`att·g1`…`att·g7`) map conceptually
  onto the REAL attention-request feature (the one genuinely novel backend the product already has).
  The plan files gates under "per-project gates — needs audit" and misses that the demo's best
  interaction loop (approve / request-changes with reason chips, "Needs you" surfacing on Home) could
  be built TODAY on attention requests with no contract change. That is the cheapest high-value
  adoption in the whole file and it appears in no wave.
- **Cross-model discussion rendering** (`disc()`, 1873–1885 — agents talking to each other, with
  attribution, inside a thread) and the **reasoning disclosure** (`<details class="reason">`
  "✳ Planned for 6s", 2008). Both are chat-surface features with real product value and real WLT
  chat-ruling interactions (C1–C9); neither is inventoried.
- **A "ruled-out-as-shown" list** (§3.3) — the plan lists what needs contracts, but never lists what
  standing rulings *forbid*, which is the list an approver actually needs.
- **Test-suite impact beyond tokens.** `mobile-audit-css-parity`, `shell-contract`, `no-router-fork`
  are named as guards, good — but nothing says WHO re-baselines `tokens-verbatim` and how the
  reference file's provenance is recorded (D-entry naming the source values), which is exactly the
  D73 failure mode (a mitigation named but never configured).

### 3.6 · The strongest argument for not doing this at all — and the narrower cut

**Against wholesale adoption:** the product's current design suite survived twelve adversarial rounds,
fifteen-plus user rulings, and seventy-five ledger entries, and is enforced by tests; the prototype is
a self-cited sales demo whose claimed authority cannot be produced, which fabricates capability
(provider-verified state, undo, compliance) as casually as it fabricates data, and which — measured —
contradicts six of the ten laws. Re-theming and restructuring a governed codebase to chase an
unaccountable artefact inverts the entire authority model this program built; if DESIGN.md v1.2 later
surfaces and disagrees with what was reverse-engineered, the work is done twice. The demo's real
asset is *narrative* (provenance chain, gates, evidence chips), and narrative is adopted through
product design, not through CSS.

**The narrower cut this lane recommends** (vs the plan's "approve Waves 1–3"):

1. **Wave 1 as specified** — land round 3, write the tables, put D76 to a human. Cheap, reversible,
   zero authority implications. *(Unchanged.)*
2. **The gate/attention loop as the first build** — approve/request-changes + "Needs you" on Home,
   wired to real attention requests. Highest demo-value-per-risk in the file; no contract change.
   *(New — replaces "re-theme first" as the flagship adoption.)*
3. **Wave 2 only after Q2 + the persona-palette question are BOTH ruled**, with the token kill-list
   in the D-entry. **Wave 3a only** (resolving destinations), 3b deferred. Waves 4–5 re-planned once
   the ruling exists, per the plan.

The difference from the plan is small in words and large in posture: the plan's first shipped change
is *cosmetic* (the skin), this lane's is *substantive* (the loop the demo actually sells), and the
cosmetic change waits until the two open design questions stop being open.

---

*Lane D deliverable ends. Nothing above modifies `DECISIONS.md`, `src/`, or any existing round
directory.*
