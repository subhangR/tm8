# tm8 Final Design Set

**Status:** W0 complete; Vega-adopted cross-layer design; workspace v2.11 Round-12 GO; fresh Claude Opus 5 **G0 APPROVE** recorded; W0-E G0.1 is **APPROVE if and only if** session `sess_1785040472762_0wsb78pdj` returns APPROVE with zero blockers/majors against the exact bound hashes  
**Date:** 2026-07-26  
**Implementation authority:** the amendment dossier is design authority only. W1 has been started but is paused at its safe pre-edit authority boundary until the binding G0.1 verdict; W0-E authorizes no package, migration, test, UI, or Remote edit.  

This file is the entry point to the tm8 architecture and product-design package. It does not restate every contract. It identifies the authority for each concern, records the cross-document rulings that all companions must share, and prevents a reader from treating a proposal as shipped behavior.

## 1. Authority order

When two documents appear to disagree, use this order:

1. shipped migrations and package source for implemented behavior;
2. `packages/contract/src/catalog.ts` plus shared DTO and Zod schemas for the frozen API;
3. `docs/tm8-architecture/00-10`, including the T-D decision log, for adopted architecture;
4. `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` plus `WORKSPACE-LAYOUT-REVIEW.md` for the closed workspace/domain rulings and their adversarial ledger;
5. an approved post-freeze amendment dossier for implementation authority;
6. the companion designs indexed below.

The companion documents are deliberately subordinate. Their value is explanation, complete proposed grammar, UI behavior and implementation-ready amendment input—not permission to contradict the layers above.

## 2. One coherent product model

| Concern | Canonical decision |
|---|---|
| Root product domain | **Server**, analogous to a Discord server; the runtime is **tm8-server**. `hubspace` is retired. |
| Collaboration boundary | **Space**. Membership, graph data, authorization, durable event ordering and replay are Space-scoped. |
| Working UI | **Workspace**, the product's three-panel composition. It is not a Server, Space, Project or CLI container. |
| Execution root | **ProjectResource**, a Server-local configured working directory with optional vendor-neutral repository metadata. |
| Project in a Space | One restricted **project projection** per active `(space, ProjectResource)` link, mapped by `project_links`. ProjectResources do not become ordinary graph-authoring entities. |
| Work-session Projects | A work_session has writable M:N `in_project` associations, capped at 16 live edges with owner/admin deletion as repair. One optional `launchProjectId` records initial cwd/worktree provenance and is not the complete Project set; it is immutable by current write-path construction and the dossier adds a DB trigger. |
| Terminal | Always a complete, first-class native interactive Claude/Codex PTY surface. It is never reduced to logs, a fallback, or a provider-capture approximation. |
| Chat | Optional peer surface in the same work-session Content region, selected through a Terminal/Chat switch. The two surfaces are never split and switching does not restart/dispose Terminal. |
| Communication truth | Ordinary anchored graph messages. Chat and Discussion are two renderings of the same message store. There is no session-chat table, reporting channel, or second inbox. |
| Feed scopes | `entities.feed` accepts API request `default|direct_v1|session_chat_v1`; `default` resolves by kind and the response echoes the concrete versioned name/predicates. CLI, profiles, and persistent preferences expose/pin only `direct_v1|session_chat_v1`, never `default`. Anchor read authorization governs every authored/reply-derived row. |
| Public delivery | `execution.prompt` stays frozen v1 but is callable only by the audited Server-internal delivery principal for a pre-reserved stored message. Every Member/Teammate caller is `forbidden/use_message_send` before queue admission with zero PTY bytes. |
| Wake breaker | Every Teammate-authored live send/reply reserves under one durable locked unordered work-session pair; a new thread root cannot escape the four-reservation allowance. |
| Phase-1 provider capture | `providerCaptureMode='explicit-only'`. Only explicit tm8 message/reply operations author Chat messages. PTY output never does. |
| UI Templates | Static, typed, versioned Server/UI registry entries. No `ui_template` entity, template mutation API, template CLI noun, or agent-generated template exists in Phase 1. |
| Interaction Profiles | Restricted reusable graph entities selecting a static template version and harness/feed/composer policy. Spawn resolves and immutably pins the complete validated profile snapshot. |
| Profile relations | `team_member --defaults_to_profile--> interaction_profile`; Server-materialized immutable `work_session --selected_profile--> interaction_profile`; `work_session_interaction_pins` is sole runtime authority. |
| Durable events | Grandfathered `WorkspaceEvent` envelope, ordered/replayed by `(spaceId, seq)`. Presence and Terminal bytes never advance the durable cursor. |
| Remote Servers | Phase 2. Remote resolution/authentication/gateway transport forms a separate control plane; after Server resolution, clients use the same domain API rather than a remote-only graph API. |

## 3. Phase-1 runtime path

```text
Member/Teammate requests execution.spawn
  -> tm8-server authenticates actor and resolves Space/task/Project context
  -> resolve active Interaction Profile
       explicit human override
       -> Teammate defaults_to_profile
       -> typed Space default
       -> built-in core
  -> validate static template key/version and Phase-1 explicit-only policy
  -> persist immutable work_session_interaction_pins snapshot/hash
  -> materialize selected_profile projection
  -> compute cwd/trust and create work_session graph state
  -> compile provider-specific Claude/Codex bootstrap + lazy discovery policy
  -> inject scoped tm8 credential/context
  -> launch the full native interactive provider CLI in PTY

Terminal surface <-> raw PTY input/output and replay
Chat surface     <-> entities.feed over explicit messages + activity
agent mutations  -> canonical catalog/CLI -> graph RPC/ledger
                 -> per-Space WorkspaceEvent -> Workspace stores/UI
```

Terminal and Chat are peers with different data sources. Terminal displays the provider's actual interactive process. Chat displays durable collaboration state. Neither fabricates the other.

## 4. Document index

| Area | Owning document | What it provides |
|---|---|---|
| Product vision, laws, architecture, security and adoption history | `docs/tm8-architecture/00-10` | Master adopted corpus and T-D decision log. |
| Workspace layout, terminology, Project projections, M:N Projects, Terminal/Chat, profiles and message-first ruling | `docs/plans/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` | v2.11 FINAL GO with RULINGS I–M and Round-12 delta closure. |
| Adversarial history | `docs/plans/WORKSPACE-LAYOUT-REVIEW.md` | Finding-by-finding ledger and GO evidence. |
| Domain, entities and tables | `docs/plans/DOMAIN-ARCHITECTURE-DECISIONS.md` | Grouped domain model, 43-table implemented baseline and amendment map. |
| Frozen and proposed API | `docs/plans/TM8-API-CATALOG-GROUPED-GUIDE.md` | All 81 frozen operations by family plus post-freeze amendment groups. |
| Complete CLI grammar | `docs/plans/TM8-CLI-GRAMMAR-REDESIGN.md` | Noun-first graph/domain grammar, output/errors/idempotency, 81-row disposition and proposed surfaces. |
| Messages, delivery, replies, inbox, attachments and handoffs | `docs/plans/TM8-SESSION-COMMUNICATION-MODEL.md` | Closed Round-4 message/delivery model and required schema/API guards. |
| Agent bootstrap, lazy command discovery and orchestration | `docs/plans/TM8-AGENT-HARNESS-AND-COMMAND-DISCOVERY.md` | Bounded prompt/context journey, provider-specific native launch and recovery/conformance rules. |
| Current implementation reality and Chat backend seams | `docs/plans/TM8-CURRENT-BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md` | Source-backed implemented/contracted/proposed distinctions, feed/profile/static-template rulings. |
| Complete Chat/Terminal UI and layout | `docs/plans/TM8-CHAT-UI-AND-LAYOUT-DESIGN.md` | Workspace placement, Terminal/Chat switch, feed/composer, delivery/inbox states, routes, keyboard, responsive and accessibility rules. |
| Exact W0 amendment authority | `docs/plans/TM8-W0-AMENDMENT-DOSSIER.md` | A01–A20, frozen-row deltas, DTO/Zod/errors, authorization, SQL/RLS/locks/retention/backfill/repair/rollback, events, CLI and conformance. |
| Total W0 consistency proof | `docs/plans/TM8-W0-CONSISTENCY-MATRICES.md` | Total kind and 81+20 operation matrices with shipped/adopted status. |
| W0 gate evidence | `docs/plans/TM8-W0-GATE-REPORT.md` | Source counts, closure evidence, hashes, process audit and fresh Opus verdict. |
| W0-E G0.1 amendment evidence | `docs/plans/TM8-W0-G0.1-AMENDMENT-REPORT.md` | Two-contradiction source proof, exact storage/RPC reconciliation, non-drift evidence, rotated hashes and binding reviewer. |
| W1–W5 handoff state | `docs/plans/TM8-W0-W5-HANDOFF-STATE.md` | Wave entry gates, unstarted state, spawn/provider/polling invariants and risks. |
| Remote connection model | `docs/plans/PHASE-2-REMOTE-SERVER-INTEGRATION.md` | Separate Phase-2 control plane mapped onto the same local Server domain/API. |

## 5. API boundary

The frozen semantic catalog contains **81 operations**: 79 v1 and 2 reserved; 80 mounted HTTP bindings and one WS binding. The registerable HTTP-handler ceiling is **78** because the WS row and two reserved rows are not handler-registerable. With a configured database, **28** semantic HTTP handlers are wired today. Catalogued, mounted, registerable, and implemented are distinct facts.

The consensus proposal does not casually append operations to that count. New operations/DTOs live in the amendment sections until adopted. The major proposed groups are:

- workspace/menu/default-channel and handoff dossier operations;
- Project projection/M:N session corrections and scratch/trust inputs;
- atomic multi-anchor messages, guarded attachments, delivery facade and Teammate inbox projection;
- universal `entities.feed`, typed activity/provenance and edge update visibility;
- restricted Interaction Profile lifecycle/default writers, with `preview` classified as a read;
- no Phase-1 provider event operations and no UI Template operations.

Every API retains ordinary identity, membership, act-as, capability, validation, optimistic concurrency, mutation-ledger and confirmation checks. Static template bindings and profile policy can hide or narrow actions; they cannot grant one.

## 6. CLI boundary

The canonical grammar is noun-first and domain/graph-native:

```text
tm8 <noun> [<subnoun>...] <verb> [arguments] [options]
```

There is no `report`, `progress`, `whoami`, public `session prompt`, compatibility alias layer, or `tm8 push`. State uses task/entity commands; communication uses messages; relationships use edges; runtime lifecycle and Terminal access use session commands.

Restricted entity kinds may receive a named operation/CLI family only when universal create/patch is refused and their lifecycle/access pattern cannot fit universal CRUD plus the closed generic command namespace. Reads remain universal. This admits messages, execution-owned work sessions and Interaction Profile lifecycle writers without opening `task create`, `doc get`, or similar aliases.

## 7. UI and layout boundary

The Workspace remains the three-panel working view. A work_session Content renderer retains the existing TerminalPool-backed Terminal and adds optional Chat as a peer mode. The switch changes presentation, not process ownership or graph truth:

- Terminal mode keeps the PTY lease alive, owns terminal keyboard behavior when focused and preserves viewport/scroll state;
- Chat mode uses the text-entry keyboard layer and the profile-pinned `entities.feed` named scope;
- Discussion may render the same anchored messages in the entity-wide collaboration view;
- switching never creates, copies, reparents or marks a message read by itself;
- invalid/missing Chat configuration cannot suppress Terminal;
- no layout puts Terminal and Chat in a simultaneous split view for one work_session.

Exact regions, responsive states, keyboard rules, routes, empty/error/loading states and accessibility semantics belong only to the UI/layout document.

## 8. Review and adoption gates

The package is design-complete only when all of the following are recorded:

1. message/delivery/feed/inbox/participant/attachment Round-4 closure — **GO**;
2. dedicated Interaction Profile authority/lifecycle closure — **GO, no residuals**;
3. Chat UI/layout document closure — **GO, C1–C9 resolved**;
4. workspace spec v2.11 cut with additive RULING K (two-mode Content), RULING L (profiles/pins/static templates) and RULING M (message-first public surface) — **completed**;
5. targeted adversarial delta review of K/L/M+C6/C7 — **Round 12 GO, 4/4 findings resolved, no residuals**;
6. T-D20/R17 public-authoring reversal recorded as T-D23 in the master corpus — **Vega adopted in W0**;
7. one exact §8 amendment dossier as the sole W1–W5 design authority — **frozen in W0 and narrowly amended by W0-E for G0.1; no implementation claim**;
8. reference capture, keyboard/browser matrix and prototype-validated byte/limit constants — **pending implementation-preparation work**;
9. fresh Claude Opus final review of this complete indexed set — **G0 APPROVE**, session `sess_1785036862149_jx2k5cx86`; W0-E G0.1 is bound to fresh session `sess_1785040472762_0wsb78pdj` and becomes **APPROVE only on that session's zero-blocker/zero-major APPROVE** against dossier `b85a1830…4805` and unchanged matrices `fa2c304a…1c60`;
10. explicit direction to implement — **given for W1, which remains paused until the G0.1 condition in item 9 is satisfied**.

Until those gates close, the documents may guide discussion and dossier authoring but must not be described as shipped code.

## 9. Explicit non-goals

- no Phase-1 remote/gateway implementation;
- no provider-output scraping into messages;
- no Phase-1 Claude SDK/JSON or Codex app-server dependency;
- no dynamic or agent-authored UI Templates;
- no second Chat/message/inbox store;
- no conversion of ProjectResources into ordinary graph-write entities;
- no repo-string identity inference;
- no implementation, migration, contract freeze amendment or build started by this documentation pass.
