# tm8 W0-E G0.1 Amendment Report

**Date:** 2026-07-26  
**Scope:** formal documentation/design-only correction of two contradictions found by the W1 pre-edit authority check  
**Binding rule:** G0.1 is APPROVE if and only if fresh evidence-only Claude Opus 5 session `sess_1785040472762_0wsb78pdj` returns APPROVE with zero unresolved blockers and zero unresolved majors against every hash in §7; its task verdict is incorporated by reference  
**Non-goals:** package, migration, test, UI, Remote Phase 2, catalog, or git changes

## 1. Entry condition

The former G0 record bound:

```text
b852e62bf6da09aaa9adb65e21c80362082c083db77b87ea829d27f0a1e5c278  TM8-W0-AMENDMENT-DOSSIER.md
fa2c304a5ee24ee7c5d9eb47e157c38eb8d5aa6145b8a4a99046ae0a21f11c60  TM8-W0-CONSISTENCY-MATRICES.md
```

W1 stopped its contract/storage work before the contradictory authority could be implemented. At the handoff boundary there was one intentional red contract test, zero migration/DB changes, and four isolated identity files whose focused checks were 6/6 green. W0-E did not edit or test any of those files.

The two contradictions were literal:

1. A20 and `SetSpaceProfileDefaultInput.expectedSettingsRevision` require a typed Space profile default, and the resolution chain uses it, but dossier §8.1 named no storage.
2. Dossier §5.1 named three database RPCs plus one execution-adapter write, while §8.4 incorrectly called them “four delivery RPCs.”

## 2. Read-only source proof

The coordinator and two independent OpenAI/Codex auditors read the governing W0 authorities and inspected `packages/contract/src/contract.ts`, `schemas.ts`, `catalog.ts`, the relevant Server/execution identity and PTY seams, and migrations 001–014.

Delivered source remains intentionally behind the adopted target:

- `public.spaces` currently has no default-channel, settings-revision, or profile-default column (`001_core_graph.sql` §4);
- current contract DTOs/settings and the 81-row catalog contain no A20 implementation;
- migrations 001–014 define none of `reserve_session_message_delivery`, `claim_session_message_delivery`, or `settle_session_message_delivery`, no delivery tables, and no dedicated delivery DB role;
- `public.record_execution_command` is the ordinary Member-authorized prompt/terminate ledger path, not an internal delivery RPC and not an approved fourth operation;
- the governed adapter effect is the PTY `proc.write` path, so it is non-database.

The package/migration tree digest was identical before and after W0-E:

```text
143f7b14879a29506f2390899ab72983d9139971debd674fdb86aa9754f83cc9
```

## 3. Exact Space default resolution

No new operation, entity, relation, or table was added. A20 keeps its frozen name, method/path, command kind, DTO, output name, handler binding, CLI disposition, and test owner.

The minimum typed storage is:

```sql
spaces.settings_revision integer NOT NULL DEFAULT 1
  CHECK (settings_revision >= 1)

spaces.default_interaction_profile_id uuid NULL
  REFERENCES interaction_profiles(entity_id) ON DELETE RESTRICT

CREATE INDEX spaces_default_interaction_profile_idx
  ON spaces(default_interaction_profile_id)
  WHERE default_interaction_profile_id IS NOT NULL;
```

`interaction_profiles.entity_id` is the typed primary key. `NULL` means no Space default, so resolution continues authorized human override → Teammate `defaults_to_profile` → Space default → built-in core. Space remains a non-entity, and the Space setting is never modeled as an edge.

`set_space_profile_default` is the sole application writer. It requires an authenticated human Member owner/admin derived from the target Space, independently of actor selection; agent, system, and act-as attempts fail the human-principal boundary. For non-null selection it locks the profile entity and active version before the Space, verifies same-Space/readable/live, not retired, active version/hash, matching successful immutable validation/hash, and the generated-profile confirmation when applicable. It then locks the Space, compares `expectedSettingsRevision`, and either returns a no-write conflict with `details.currentRevision` or applies one change/revision/event/ledger transaction.

Exact replay never increments or emits twice. A new mutation requesting the stored value still checks the expected revision and records the result but does not change the row, increment the revision, or emit an event. A20 clear locks only the Space. Retirement shares the profile-first order and refuses referenced defaults rather than silently clearing them.

Reads project the ID/revision through member-authorized Space settings/A20 output, never public Space summary/discovery. The application role has no direct writes. Existing Spaces backfill `settings_revision=1` and `default_interaction_profile_id=NULL`; no profile/default is inferred. Forward rollback quiesces the binding, clears defaults under Space locks with revision advancement, appends core pin revisions rather than mutating historical pins, and removes the index/FK/column only in a compensating migration after references are gone.

## 4. Exact delivery allowlist

The dedicated delivery role may execute exactly these three database RPCs:

```text
reserve_session_message_delivery
claim_session_message_delivery
settle_session_message_delivery
```

Their defining migration revokes default/PUBLIC and application-role execution before granting only the dedicated unprivileged role. They validate the internal delivery tuple and accept no caller-selected actor claims. The one separately governed execution-adapter `proc.write` effect is not a DB RPC and grants no table, graph-write, Member, Teammate, or act-as authority. No expiry, recovery, retention, cleanup, or notification RPC is implied or approved.

This preserves the B1 pre-queue identity refusal, zero-queue/zero-byte negative law, delivery-row state invariants, and the B2 unordered-pair budget.

## 5. Catalog and matrix non-drift

Mechanical checks retain:

```text
source catalog rows = 81 (79 v1, 2 reserved)
baseline matrix rows = 81
additive matrix rows = 20 (A01–A20)
target after implementation = 101
```

The baseline matrix remains a name-set bijection with the current catalog. The additive A01–A20 names and bindings remain identical between dossier and matrix. `TM8-W0-CONSISTENCY-MATRICES.md` is byte-for-byte unchanged because neither A20 metadata nor any other catalog/kind disposition changed.

## 6. Exact documentation scope

Changed only:

- `TM8-W0-AMENDMENT-DOSSIER.md` — the exact storage, view, writer, lock, revision, backfill, RLS/rollback rules and three-RPC wording;
- `TM8-W0-GATE-REPORT.md` — G0.1 evidence/binding and current W1 pause;
- `TM8-W0-W5-HANDOFF-STATE.md` — G0.1 entry condition and preserved W1 resume boundary;
- `TM8-FINAL-DESIGN-SET.md` — authority-index status and G0.1 evidence link;
- this report.

No subordinate narrative was edited merely to restate the ruling. No file under `packages/`, `db/migrations/`, tests, UI source, or Remote Phase 2 was changed, and no git command was run.

## 7. Hash rotation and binding set

Former → G0.1 hashes:

```text
TM8-W0-AMENDMENT-DOSSIER.md
  b852e62bf6da09aaa9adb65e21c80362082c083db77b87ea829d27f0a1e5c278
  b85a18304f3769ba88da67403a7d90331a17c6355df7b451d650b49990434805
TM8-W0-CONSISTENCY-MATRICES.md
  fa2c304a5ee24ee7c5d9eb47e157c38eb8d5aa6145b8a4a99046ae0a21f11c60
  fa2c304a5ee24ee7c5d9eb47e157c38eb8d5aa6145b8a4a99046ae0a21f11c60  (unchanged)
TM8-W0-GATE-REPORT.md
  b2297a53a6f1898b0843344a1f16bb31d8e0928dc2c1ba3587c4e135f1e03af1
  b4f11818bcc9fc623392d1d7492f4b773c4b884d9b8452bc9166af53e704ce4f
TM8-W0-W5-HANDOFF-STATE.md
  83730b587f8a14fedd20bfaf615bc976470595215ed79dd2f6d1405dc6c11188
  f26ad659a550ac50214699da6fb68388de54e69d8694421af9188b3e633c342b
TM8-FINAL-DESIGN-SET.md
  501178fefd67a49d551d27e9cb63d52c53cfc46a8a1802e0e8860e26e28b778b
  b3d54cac1d86a2fe3151d6a9d997499f7c62a058852244a986cbab6f4c29ab9e
```

This report's own SHA-256 is supplied in the reviewer task and Maestro completion record to avoid a self-referential hash.

## 8. Independent audits and binding review

| Role | Task / session | Launch audit | Result |
|---|---|---|---|
| Space default audit | `task_1785039790391_w73unk16m` / `sess_1785039818253_rufejxknf` | provider=openai, agentTool=codex, model=gpt-5.6-terra, reasoningEffort=xhigh, fullAccess | complete, read-only, no edits/git |
| Delivery allowlist audit | `task_1785039790543_sdidtgrfj` / `sess_1785039820311_lvoz8027i` | provider=openai, agentTool=codex, model=gpt-5.6-terra, reasoningEffort=xhigh, fullAccess | complete, read-only, no edits/git |
| G0.1 gate | `task_1785040440249_kuqduf24g` / `sess_1785040472762_0wsb78pdj` | intentional provider=claude, agentTool=claude-code, model=claude-opus-5, fullAccess | final verdict incorporated by reference |

The fresh Opus session was staged without reading files so its ID could be embedded before final hashing. It reviews only the two contradictions, the exact resulting storage/RPC freeze, invariant consistency, unchanged catalog/matrix/source evidence, and W1 resume safety. APPROVE with zero blockers and zero majors records G0.1; any other result keeps W1 paused. Any later edit rotates the affected hash and requires a different fresh reviewer.
