# tm8 — Static Template Block Vocabulary · Runtime Config vs Team Member · Model Tiers

**Status:** Design proposal, decisive-by-default (user depth directive: core things right, 90–95%, no review-ledger spiral). Secondary details are in §5 OPEN with a recommendation each.
**Date:** 2026-07-27
**Subordinate to:** `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11 (RULING L), `TM8-CHAT-UI-AND-LAYOUT-DESIGN.md` (§9.6, §14, §15), `TM8-AGENT-HARNESS-AND-COMMAND-DISCOVERY.md`, `TM8-CLI-GRAMMAR-REDESIGN.md`. Nothing here reopens a closed ruling; §4 proves it.

---

## 0. Verdicts

| Part | Question | Verdict |
|---|---|---|
| 1 | Static Template block vocabulary | **Real gap, confirmed.** §9.6 names the customization surface but no doc defines the approved block set. Defined below as a closed, versioned, deploy-validated vocabulary (`tm8.template.v1`). |
| 2 | "Separate runtime config from team members" | **Already substantially decided — RULING L is this proposal.** The `interaction_profile` + immutable pin *is* the runtime config, and `team_member` already keeps only persona + model + a `defaults_to_profile` pointer. The one genuine delta the user's wording invites — moving **model** into the runtime config — should be **rejected**: model/provider is an execution-capability axis resolved on a deliberately separate track (`manifest.ts:112`), and folding it into the profile would force a profile-per-model matrix and couple presentation policy to execution capability. What Part 3 changes is *what the team_member's model slot points at*, not where it lives. §2 records the split explicitly. |
| 3 | Model tiers as a dynamic entity | **Right, including the "not sure" part being resolved in favor of an entity.** Confirmed shape: a tier is a **selection policy**; spawn resolves tier → concrete model → records the concrete model on the `work_session` row exactly as today. Changing a tier changes future spawns only — the immutable-pin law is never touched. Selection is **priority-ordered first-available**, not random. Tiers are a far better entity candidate than templates: templates name registered code components (deploy problem ⇒ registry asset — the exact M12-1 boundary); tiers are pure data — a list of model identifiers with zero code coupling — so a bad tier fails at spawn with a clean error, not at deploy. Entity placement gives versions, activity audit, Discussion, and the delete-guard machinery for free. It does **not** need the heavy restricted seven-command lifecycle family: its invariants fit universal CRUD plus a kind-level write gate (§3.4). |

---

## 1. Part 1 — The static Template block vocabulary (`tm8.template.v1`)

### 1.1 What a template is, concretely

A static template is a **typed, versioned, deploy-validated registry asset** shipped with the Server/UI binary — never an entity, never CLI-authorable, never agent-authored (`WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:22` RULING L; `TM8-CHAT-UI-AND-LAYOUT-DESIGN.md` §1.6, §23). Its entire payload is the parameterization below. It reaches the browser only inside the profile's sanitized presentation projection (`TM8-AGENT-HARNESS-AND-COMMAND-DISCOVERY.md:203`); there is no template read API family.

```ts
type StaticTemplate = {
  key: string;                      // registry identity, e.g. "tm8.core", "tm8.dense-ops"
  version: number;                  // immutable once shipped; new content = new version
  schemaVersion: 'tm8.template.v1';
  density: 'compact' | 'cozy' | 'comfortable';
  blocks: BlockSelections;          // §1.2 — per-item-class variant + params
  labels: LabelOverrides;           // §1.3 — closed slots, bounded plain text
  iconTokens: IconTokenMap;         // §1.3 — kind/verb slots only
  activityGrouping: ActivityGroupingPolicy;   // §1.4
  composerWidgets: ComposerWidgetConfig;      // §1.5
  initialSurface?: 'terminal' | 'chat';       // §5.2 first-open default only
};
```

Validation happens **at registry load (deploy time)**: every block variant, icon token, label slot, and widget name must exist in the binary's registries. A template referencing an unknown variant is a build failure — this is precisely why templates are registry assets and not entities.

### 1.2 The block set — one block class per feed-item presentation class

The region layout of the Chat surface is **fixed** (header → notice → feed → new-items marker → composer, §7.1 of the Chat UI doc). A template never rearranges regions, reorders the chronological feed, or removes a region. "Layout blocks" means: for each feed-item class, the template selects one **registered variant** and sets its bounded params.

| Block class | Renders (§9 ref) | v1 variants | Parameters | Non-negotiable floor |
|---|---|---|---|---|
| `message` | Message items (§9.1) | `bubble` \| `row` | `showAvatar`, `timestampStyle: relative\|absolute`, `provenanceLabels: full\|abbreviated` | Author, direction-as-text, provenance, time, edited/redacted state, canonical anchor always rendered; content selectable |
| `artifact` | Artifact cards (§9.2) | `card` \| `inline-row` | `summaryLines: 0..3`, `actionsPlacement: inline\|overflow` | Kind, title, actor, producing session, timestamp, canonical anchor; actions come only from action discovery |
| `state-change` | Lifecycle rows (§9.3) | `row` | `detail: compact\|expanded` | Before/after values from the typed activity summary only |
| `activity-group` | Low-level mutation groups (§9.4) | `grouped` \| `flat` | see §1.4 | Grouping only by logical-operation key; count always shown; accessible expand |
| `reply-context` | Reply bubbles (§12) | — | `indent: on\|off`, `parentPreviewLines: 1\|2` | Parent preview + canonical anchor always present; depth stays bounded to one visual level |
| `delivery-facet` | Delivery state (§9.5, §11.2) | `badge` \| `badge+text` | none | **State slots are not template-mappable.** Every non-success state renders with its §11.2 label and treatment; a template can never restyle `unknown`/`failed` toward success or suppress a facet |
| `notice` | Context/connectivity/profile banner (§7.1) | `banner` | none | Shown whenever the Chat UI doc requires it (fallback notice, reconnect, permission) — not suppressible |
| `new-items` | New-items marker (§7.2) | `marker` \| `floating-button` | none | Never auto-scrolls a viewer who scrolled up |
| `chat-header` | Session context strip (§7.1) | `strip` | subset of the allowed field set {teammate, provider, liveState, deliveryAvailability} | May only omit fields, never add ones outside the safe set |
| `empty-state` | Empty feed (§17) | `standard` | label slots only | Must state that native provider output remains in Terminal |
| `core-card` | Unknown feed variants (§8.4, §14.3) | `core` (exactly one) | **none — non-parameterizable** | Timestamp, actor, open-details. Mandatory mapping for any unrecognized variant; a template cannot redirect or hide it |

**Totality rule:** a valid template supplies a selection for every block class (defaults exist for all). It can never *omit* a class — that would be "hiding evidence because it doesn't recognize a feed variant," which §9.6 forbids. The variant registry is closed per `schemaVersion`; extension means a new schema version, mirroring the `session_chat_v1` scope-versioning discipline.

### 1.3 Density, labels, icon tokens

- **Density** is one global token (`compact|cozy|comfortable`) driving spacing, avatar size, and preview-line defaults. No per-block density in v1.
- **Labels** are overrides for a **closed slot set** (v1: direction labels "To/From this session", composer placeholder, empty-state title/body, send-button label, group-row verb phrasing). Values are bounded plain text (≤120 chars), rendered as text nodes only — no markup, no interpolation beyond registered placeholders like `{anchorTitle}`. This satisfies §9.6's "no HTML/CSS/expressions" without inventing a copy-token registry (see OPEN-5).
- **Icon tokens** map **kind slots and activity-verb slots only** to names from the shipped closed icon registry (`tm8.icons.v1`). Delivery-state and error-state icon slots are deliberately excluded from mapping — semantic safety states keep their fixed iconography.

### 1.4 Activity grouping options

```ts
type ActivityGroupingPolicy = {
  mode: 'by-operation' | 'off';   // 'off' = every row rendered separately (more evidence, never less)
  collapseThreshold: 2..20;       // rows sharing one clientMutationId before collapsing
  expandedByDefault: boolean;
  groupLowValueOnly: boolean;     // true: only §9.4 low-value verbs group; state changes never collapse
};
```

Timestamp-based grouping is **not expressible** in the vocabulary (§9.4 forbids it structurally, not by review).

### 1.5 Composer widgets

Mandatory, non-removable core: text input, visible Send button, reply-context display, attachment chips when a draft has attachments, validation messaging. Template-selectable widgets (closed union): `attachments`, `reply`, `mentions`, `newline-mode-hint`, `send-shortcut-hint`, and `operationButtons: OperationName[]`.

Effective widget set = template selection ∩ the profile's `ComposerInteractionPolicy` ∩ the viewer's `actions.list` result (§14.4 of the Chat UI doc). A template can only **narrow** — it can drop the mentions widget, it can never make attachments appear when `supportsAttachments:false`, and an operation button is always an action *request* re-authorized server-side. `newlineMode: 'enter-sends' | 'newline-first'` follows §10.5, with the active mode announced in input help text.

### 1.6 Versioning and compatibility (the pin-outlives-binary story)

1. **Immutability:** `(key, version)` is immutable once shipped; any change ships as a new version. The registry retains old versions while any live pin references them — "Registry versions cannot disappear while referenced by a live pin; removal requires an audited pin migration" (`TM8-CLI-GRAMMAR-REDESIGN.md:1129`).
2. **Pinned version missing** (binary downgrade, pruned registry): exactly §14.3 — preserve and display the failed key/version, open on Terminal, offer Chat through the **core renderer**, show the fallback notice, never rewrite the pin.
3. **Core renderer defined:** rendering as if the template were `tm8.core` v-current — all block defaults, default density, no overrides — visibly labeled as fallback. `tm8.core` is itself a registry entry, so "fallback" and "default template" are one code path.
4. **Newer feed than template:** unknown `FeedItem` variants hit the mandatory `core-card` mapping (§1.2); nothing is dropped. A template's `schemaVersion` gates only which *params* the binary understands; an unsupported future `schemaVersion` is treated as unresolvable → path 2.
5. **Selection:** only `interaction_profile.template {key, version}` selects a template (RULING L). Teammates "may select an already shipped static template version, but cannot author templates" (`TM8-CLI-GRAMMAR-REDESIGN.md:768`).

### 1.7 Hard-constraint conformance (§9.6 checklist)

No code/HTML/CSS/expressions/URLs/network (payload is closed enums + bounded text) · no hiding evidence (block totality + mandatory `core-card` + non-suppressible `notice`/`delivery-facet`) · no invented predicates/semantics (feed scope comes from the profile's `FeedPolicy`, never the template) · no grants (§1.5 intersection; §14.4) · no Terminal alteration (`initialSurface` is a first-open default only, §5.2 of the Chat UI doc; nothing else touches Terminal) · no PTY→Chat (templates consume `entities.feed` items only).

---

## 2. Part 2 — Runtime config vs `team_member`: the split, made explicit

RULING L already delivers the user's proposal. Recording the boundary so nobody re-derives it:

**`team_member` retains (persona + capability):**
- identity: display name, avatar, role text, owner (`schemas.ts:107-113, 175-180`)
- **model slot** — today a literal `model` string (`schemas.ts:177`); after Part 3, literal model *or* a `uses_model_tier` edge (§3.2)
- `agentTool` (normally derived from the resolved model — `manifest.ts:65 agentToolForModel`), `mode`, `permissionMode` (consumed at `manifest.ts:110-124`)
- `defaults_to_profile` guarded 0..1 edge — a *pointer* to runtime config, not runtime config itself

**`interaction_profile` (the runtime config) owns:** template key/version, prompt policy, tool-discovery policy, feed policy, `providerCaptureMode`, composer/interaction policy (`TM8-AGENT-HARNESS-AND-COMMAND-DISCOVERY.md:106-133`). Resolution at spawn: explicit human override → teammate default → Space default → core; the immutable `work_session_interaction_pins` row is sole runtime authority; later profile edits never change a running or historical session (Chat UI §14.1).

**Model deliberately stays out of the profile.** The spawn sequence resolves "teammate, provider, model, mode, and active accessible Interaction Profile" as parallel tracks (Chat UI §15 step 1), and the code does the same (`resolveLaunchConfig`, `manifest.ts:104-126`). Keep it that way: one profile ("dense ops chat") should serve teammates on any model; one tier change (Part 3) should not require touching interaction policy. The two axes — *how the session presents and is policied* vs *what engine runs it* — meet only at spawn, where each is resolved and recorded immutably (pin row; `work_session` row fields, `schemas.ts:212`).

**Design cost of Part 2: zero new machinery.** It is a documentation ruling. The only schema-adjacent consequence is Part 3's change to the model slot.

---

## 3. Part 3 — Model tiers

### 3.1 Semantics: a tier is a spawn-time selection policy

- At spawn, tier resolution runs **inside the existing model-precedence chain** and produces a concrete model name; everything downstream (agent-tool inference, launch args, `TM8_MODEL`, the `work_session.model` field) is byte-identical to today.
- The `work_session` row keeps recording the **concrete model that actually ran**. Additive nullable provenance fields record the policy: `modelTier: { entityId, entityVersion, rank } | null` — the exact `launchProjectId` immutable-provenance pattern RULING L's pin already mirrors.
- **Propagation = future spawns only.** Editing a tier never touches a running or historical session; there is no propagation machinery at all — the next spawn simply re-resolves. This confirms the lead's recommended shape and forks nothing.

### 3.2 Precedence (extends `manifest.ts:112`, no link removed)

```
request.model (explicit spawn override)
  → member.model (literal, if set — deliberate per-teammate escape hatch; wins over tier)
  → member --uses_model_tier--> tier   ⇒ first available model in priority order
  → DEFAULT_MODEL ('sonnet', manifest.ts:33)
```

`uses_model_tier` is a guarded 0..1 configuration edge (team_member → model_tier), mirroring `defaults_to_profile`: write-time validation (target kind, same Space, tier not deleted), server-refused when the writer is not a human Member with teammate-config authority. The user's goal — "configure their type once, change the tier, all of them follow" — is met by setting the edge and clearing the literal `model` field.

### 3.3 Selection rule within a tier: priority-ordered, first-available, deterministic

```ts
{ kind: 'model_tier',
  models: [ { name: string, enabled: boolean, note?: string } ],  // ordered; priority = position
}
```

- Resolution picks the **first entry** with `enabled:true` whose provider is resolvable on the node (`agentToolForModel(name)` succeeds or the entry names its tool). No randomness: the stated motivation is deprecation and limits, which wants *predictable fallback*, and determinism keeps cost and debugging sane. `manifest.ts:16` already rules that model-power ranking "belongs in model-profile DATA" — this is that data.
- **Phase-1 unavailability handling is operational, not automatic:** when a model is deprecated or rate-limited, the operator flips `enabled:false` (or reorders); every future spawn moves to the next entry. That is exactly the user's own remediation story and needs zero new saga machinery. Automatic mid-spawn failover is OPEN-2.
- Empty or all-disabled tier at spawn → typed refusal (`invariant_violation`, `details.reason='model_tier_exhausted'`), following the §7.2 pattern of existing-code + stable reason.

### 3.4 Entity, and *which kind* of entity: ordinary core kind, write-gated — not a restricted family

Confirming the lead's distinction and going one step further:

- **Templates are code-adjacent** (name registered components ⇒ deploy problem ⇒ registry asset). **Tiers are pure data** (model-identifier strings ⇒ spawn-time problem ⇒ entity). Placing tiers as entities does not touch, and in fact reinforces, the M12-1 boundary: the classification test is *what breaks when the reference is wrong*, and the two land on opposite sides.
- The restricted-kind admission rule grants a named command family "only when universal create/patch is refused and its invariant-preserving lifecycle cannot fit universal CRUD" (`TM8-CLI-GRAMMAR-REDESIGN.md:746`). Tier invariants — ordered non-empty list, valid names, delete-guard — **fit universal CRUD**, so `model_tier` is an **ordinary core entity kind** with:
  - `CoreEntityKindSchema` + detail-union + KindRegistry + §2.1 registry row (`model_tier` / slug `model-tiers` / strategy `collection`; registered day 1, not in the default menu — same posture as spells/skills, `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md:70`);
  - **kind-level write gate:** create/patch/delete require a human Member with Space owner/admin capability. Rationale: a tier edit redirects every referencing teammate's future spawns (cost and capability blast radius); agent-authored tier edits are refused, consistent with the profile-authority posture ("agent-authored drafts cannot activate themselves", §8.1) without importing its lifecycle;
  - **delete guard:** delete refused while any `uses_model_tier` edge references it (`invariant_violation`/`model_tier_in_use` + referencing IDs) — the `profile_default_in_use` pattern (`TM8-CLI-GRAMMAR-REDESIGN.md:770`);
  - full envelope for free: versions + `entities.versions` history (the audit trail the "models come and go" churn wants), Discussion, activity, connections; share/handoff uses the generic fallback projection.
- Space-scoped like every entity. Node-level sharing across Spaces is OPEN-3.

### 3.5 Layer-by-layer delta

| Layer | Change |
|---|---|
| Contract | `model_tier` in `CoreEntityKindSchema` (`schemas.ts:80-83`) + detail schema (§3.3 shape) + summary variant; `uses_model_tier` edge-type registry row (guarded writer); additive `work_session` detail provenance `modelTier?` (`schemas.ts:212` region); `ExecutionSpawnInput` **unchanged** (`model` override already exists, `schemas.ts:1216`) |
| Server/DB | `entity_kinds` row + detail storage (one additive migration); edge write guard; delete guard; kind-level authorization gate |
| Spawn | `resolveLaunchConfig` gains the tier link between `member.model` and `DEFAULT_MODEL` (§3.2); records tier provenance on the session row; typed `model_tier_exhausted` refusal |
| CLI | Universal grammar covers reads/writes (`entity get/query/versions`, gated create/patch/delete). `teammate update` gains `--model-tier <id|none>` (writes the edge). No dedicated noun yet (OPEN-4). Tier delete joins the `--yes` confirmation list (`TM8-CLI-GRAMMAR-REDESIGN.md:936` family) |
| Harness/manifest | Nothing new: the bootstrap already carries only the resolved concrete model via existing fields; agents never see tier policy (they don't need it, and it isn't secret anyway) |
| UI | Tier list/detail via generic collection + detail panels (ordered list editor + enable toggles + referencing-teammates from Connections); teammate detail + spawn dialog model picker offers "tier (resolves now to X)" alongside concrete models; session detail shows `model · via tier <name> #rank` provenance |

---

## 4. Coherence — nothing forked

1. **RULING L intact.** Templates remain config-side registry assets (§1 defines their *payload*, adds no entity/API/CLI noun — Chat UI §23 non-goals hold). `interaction_profile` remains the restricted entity; its lifecycle family, human-activation rules, and dual projections are untouched. Part 2 adds no mechanism at all.
2. **Immutable pin intact.** `work_session_interaction_pins` remains sole runtime authority; tier resolution happens **before** pinning in the §15 spawn sequence (step 1) and writes only the already-existing session-row model fields plus additive immutable provenance. "Later edits to a profile never change a running or historical session" (§14.1) now provably extends to tiers: there is no post-spawn propagation path to running sessions, by construction.
3. **Profiles narrow, never grant — extended, not bent.** Template vocabulary is intersective everywhere it touches actions (§1.5); delivery/notice/core-card blocks are non-suppressible, so a template cannot even narrow *evidence*, only presentation. Tiers carry zero authorization semantics: selecting a model was never a permission, and the tier write gate only *restricts* who may edit data that was previously a free-text field.
4. **M12-1 not relitigated.** The template ruling is consumed as-is; §3.4 uses its classification test to place tiers on the entity side — the same argument, applied, not reopened.
5. **Terminal/RULING D untouched.** `initialSurface` is the §5.2 first-open default that already exists in the Chat UI doc; no vocabulary element can gate, demote, or remove Terminal.

---

## 5. OPEN list (each with a recommendation — decide-by-default, not further review rounds)

1. **Space default tier** (fourth precedence link, mirroring the profile's Space default). *Recommend: defer* — teammate-level tiers already deliver the user's goal; add the link when a real multi-teammate-default need appears.
2. **Automatic failover when a spawn fails with a rate-limit/deprecation error** (retry next tier entry in-flight). *Recommend: defer*; Phase 1 remediation is editing the tier (`enabled:false`), which is the user's own operational model. If added later it is a bounded one-pass retry recorded in provenance.
3. **Tier scope: Space entity vs node resource + projection** (projects precedent). *Recommend: Space-scoped entity now*; promote to node resource only if cross-Space duplication demonstrably hurts.
4. **Dedicated `tm8 model-tier` CLI noun.** *Recommend: defer*; universal entity grammar + `teammate update --model-tier` suffices and keeps the noun set closed.
5. **Template labels: free bounded text vs registered copy-token set.** *Recommend: bounded plain text on closed slots* (§1.3) — simpler, still §9.6-safe; revisit only for i18n.
6. **Mixed-provider tiers** (e.g., `high = [opus-x, gpt-y]`). *Recommend: allow*; `agentToolForModel` already infers the tool per resolved model (`manifest.ts:56-67`), and provider choice remains explicit-at-spawn in the recorded result.
7. **Who may edit tiers: Space owner/admin vs any human Member.** *Recommend: owner/admin*, matching the blast radius and the profile-default authority posture.
8. **Seeded default tiers** (`high/medium/low` shipped per Space). *Recommend: yes, seed three at Space creation* as ordinary editable entities (not required rows) — gives the user's vocabulary out of the box with no reserved semantics.

---

## 6. Build sequencing & worklist impact

Order (each independently shippable):

1. **B1 — Template vocabulary** (Part 1): `tm8.template.v1` schema + block/variant/icon/label registries + `tm8.core` template + deploy-time validation + §14.3 fallback path. This is on the Chat critical path (C9 gates Chat implementation on the amendment set; until B1, every profile renders identically and §9.6 is empty).
2. **B2 — Model tiers** (Part 3): contract kind + edge + migration + spawn link + provenance + UI surfaces. Small and independent of B1.
3. **B3 — Part 2**: no build; record §2 as the standing split ruling in the decisions corpus.

**Worklist (T2-4, `~/Desktop/tm8-ui-design/04-DESIGN-WORKLIST.md:67`):**
- T2-4 (Interaction Profiles) gains one line: profile detail renders the selected template key/version and a read-only preview using the B1 vocabulary; no authoring surface for templates exists by design.
- Add sibling **T2-4b · Model Tiers**: tier list/detail (ordered editor, enable toggles, referencing teammates), teammate tier selector, spawn-dialog tier display, session provenance line — all generic-panel work, no new panel archetypes.
- No new worklist entry for Part 2.
