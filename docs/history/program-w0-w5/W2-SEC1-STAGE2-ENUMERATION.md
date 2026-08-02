# W2.SEC-1 STAGE 2 — CLASSIFIED ENUMERATION OF REPLAY RESOURCE-BINDING SITES

**Written for someone who was never here.** The fixes are the cheap part; *knowing
which sites need them* is the expensive part, and it cannot be cheaply
rediscovered. Everything below is measured from the **live `pg_catalog` of an
applied chain**, not from grepping `db/migrations` — file reading gave the
wrong answer three separate times during this work because migrations supersede
each other, and the catalog gave the right one each time.

---

## 0. READ THIS FIRST — WHAT IS AND IS NOT MEASURED

Two different claims appear below and the uniform table format must not flatten
them:

| claim | strength |
|---|---|
| **`granted to tm8_app`** | A **DB-layer** fact, measured with `has_function_privilege`. It means the application role can execute the function *as SQL*. It does **not** mean an HTTP route reaches it. |
| **measured at the public HTTP boundary** | Only **one** defect in this document has that status: the `entities.create` confusion proved by `packages/server/test/w3/xg03-same-principal-resource-confusion.test.ts`. |

Everything else is a **reachability class**, not a demonstrated exploit. Do not
upgrade a "granted" row into "measured" when quoting this.

## 1. THE MECHANISM, IN ONE PARAGRAPH

`internal.ledger_replay(cmid, operation_label)` resolves a stored command result
using **only** those two values. It therefore **structurally cannot** know which
resource the current request addresses. Migration 033 put the *principal*
comparison inside it, which closed cross-principal replay **globally** and
fail-closed on the NULL cases. The *resource* half cannot be supplied there for
the same structural reason, so it must be supplied **per site**. That is what
migration 032 did at seven sites, and what everything in class D below still
needs.

**Same-principal is the easy case here, not the exotic one.** Phase-1 runs a
single loopback auto-owner, so "same principal, different resource" is what an
ordinary caller does by accident.

## 2. THE TWO-DOORS MECHANISM — THE THING MOST LIKELY TO BE MISSED

`ledger_replay` keys on cmid + label and **cannot tell callers apart**. So when
two functions share an operation label, a row recorded through one is resolvable
through the other, and a guard written at one door does nothing at the other.

This was discovered twice by accident before it was ever enumerated. **A guard
protects a FUNCTION; the vulnerability belongs to the SITE; and a site can have
many doors.** Section 4 enumerates every collision for the first time.

**Consequence for any fix:** binding *one* door of a multi-door label is not a
partial fix, it is a **false negative** — it can turn the acceptance test green
while the defect stays fully open.

## 3. CLASS DEFINITIONS AND TALLY

| class | meaning | count | granted |
|---|---|---|---|
| **A** | Resource-bound **by construction** — the cmid *is* the resource key, so a replay cannot address a different resource | 1 | 1 |
| **B** | **Self-guarded** — carries its own equivalent check | 3 | 3 |
| **C** | **Covered** by 031/032 | 13 | 12 |
| **D** | **Still needs the resource half** — the Stage 2 work list | 81 | 78 |
| **E** | Non-disclosing | *not adjudicated — see below* | |

**TOTAL live `ledger_replay` callers: 98** (94 granted to `tm8_app`).

### Class A, with its two-doors check answered
`public.w2_prepare_handoff` — calls `internal.ledger_replay(p_handoff_id::text,
'handoffs.send')`. The **cmid is the handoff id**, so there is no separate
addressed resource to confuse: a replay can only ever be addressed with the key
that *is* the cmid. **Two-doors check: `handoffs.send` has exactly ONE live
function**, so no sibling can bypass it. This is the class the deferral ruling
predicted would exist; it has exactly one member.

### Class B, with its two-doors check answered
- `public.mark_read`, `public.mark_notification_read` — the 023 pattern: a
  pre-check reading `public.command_ledger` directly, plus a stored-subject
  comparison inside the replay branch.
- `public.w2_post_message_batch` — recomputes an identity-salted hash over the
  request canonicalization and refuses on mismatch. **Two-doors check: FAILS
  CLEANLY.** `messages.post` also belongs to `public.post_message`, whose door was
  bound by 032 precisely because this guard does not protect it.

### ⚠ Class E was NOT adjudicated per site, and that is deliberate
Class E ("the replay discloses nothing a caller could not already obtain")
requires a per-site judgement about what is otherwise obtainable. It is **the
class most likely to be wrong in the reassuring direction**, and this program has
already had one all-clear defeated by an unstated premise. Adjudicating 81 sites
to that standard is investigation, not enumeration, and it was not in budget.

**No site is cleared as class E.** Every site that is not A, B or C is listed as
**D**. If a future implementer wants to demote sites to E, that is legitimate
work — but it must be done per site, with the two-doors question answered each
time, and it must not be done by pattern-matching the shape of the stored
projection.

## 4. LABEL COLLISIONS — enumerated here for the first time

```
label                              doors granted  status
edges.create                           2       2  ALL DOORS UNBOUND, >1 GRANTED — fully open
entities.create                       11      11  ALL DOORS UNBOUND, >1 GRANTED — fully open
entities.patch                        11      11  ALL DOORS UNBOUND, >1 GRANTED — fully open
messages.delete                        2       1  MIXED, 1 granted — latent (closed door not executable by tm8_app)
messages.edit                          2       1  MIXED, 1 granted — latent (closed door not executable by tm8_app)
messages.post                          2       1  MIXED, 1 granted — latent (closed door not executable by tm8_app)
projects.link                          2       2  ALL DOORS UNBOUND, >1 GRANTED — fully open
projects.unlink                        2       2  ALL DOORS UNBOUND, >1 GRANTED — fully open
projects.update                        2       2  MIXED, >1 GRANTED — bound door BYPASSABLE (live)
spaces.invites.redeem                  2       2  all doors protected
spaces.invites.revoke                  2       2  all doors protected
spaces.menu.update                     2       1  MIXED, 1 granted — latent (closed door not executable by tm8_app)
spaces.taskAxes.create                 2       2  ALL DOORS UNBOUND, >1 GRANTED — fully open
spaces.taskAxes.delete                 2       2  ALL DOORS UNBOUND, >1 GRANTED — fully open
spaces.taskAxes.update                 2       2  ALL DOORS UNBOUND, >1 GRANTED — fully open
spaces.update                          2       2  MIXED, >1 GRANTED — bound door BYPASSABLE (live)

```

### The four LATENT collisions, and WHY they are latent

"Latent" here means **the second door exists and is unbound, but `tm8_app` cannot
execute it**. It does **not** mean safe. It means one `GRANT` away from live.

| label | bound & granted door | unbound door | why latent |
|---|---|---|---|
| `messages.edit` | `w2_edit_message` (bound by 032) | `edit_message` | `019:1321-1323` explicitly `revoke execute … from tm8_app`, overriding the `008:234` blanket grant |
| `messages.delete` | `w2_tombstone_message` (bound by 032) | `redact_message` | same `019:1321-1323` revoke block |
| `spaces.menu.update` | `update_space_menu` (bound by 031) | `set_space_menu_config` | not granted to `tm8_app` |

**`messages.post` does NOT fit that table and an earlier revision of this document
filed it there incorrectly** — it listed `post_message` under "unbound door" while
the same row noted it was bound by 032, which is self-contradictory. The true
shape is the reverse of the other three:

| door | granted? | protection |
|---|---|---|
| `public.w2_post_message_batch` | **GRANTED** — and it is what `messages-handoffs.ts:319` actually calls | **self-guarded** by the identity-salted batch hash (`019:386-398`); it has **no** `require_replay_subject` |
| `public.post_message` | **NOT granted** (`019:1321`) | **bound** by 032 |

So the *granted* door is protected by a hash rather than by the 031 helpers, and
the *bound* door is the unreachable one. Two independent readers reached the same
conclusion here through **incompatible models of which function was which**, which
means neither model was load-bearing — **the batch hash is the actual reason this
label is safe**, and any future reasoning about it should rest on that and not on
which door happens to carry `require_replay_subject`.

### ⚠ TWO COLLISIONS ARE **LIVE**, NOT LATENT — DELIVERED WORK IS CURRENTLY BYPASSABLE

Both doors granted, one bound and one not. **The binding we shipped can be walked
around by an ordinary `tm8_app` caller using the other door, same principal.**

| label | bound door | UNBOUND + GRANTED door | consequence |
|---|---|---|---|
| `projects.update` | `update_project_w2` (bound by **032**) | **`public.update_project`** (007) — bare `return replay`, stores `jsonb_build_object('project', to_jsonb(project), …)` | 032's binding is bypassable |
| `spaces.update` | `w2_update_space` (bound by **031**) | **`public.update_space`** (007) — bare `return replay` | 031's binding is bypassable |

These are **repair of delivered work**, not new scope: 031 and 032 were shipped
asserting these labels were bound, and as of this chain they are not.

**The one label that IS completely closed is `spaces.invites.revoke`** — both
`revoke_invite` and `w2_revoke_invite` are bound. It is the only two-door label in
that state, and it got there because the unrouted sibling was deliberately ruled
*in* on the principle that **"unreachable today" is a statement about today**.
That single ruling produced the only complete label in the set. Apply it.

## 5. THE IDIOM — copy it, do not reinvent it

Helpers already exist and need no new migration:
- `internal.require_replay_principal(text)` — `db/migrations/031_w2_sec1_replay_principal_resource_binding.sql:172`
- `internal.require_replay_subject(text, text, text)` — `031:208`

Worked example, `public.w2_edit_message` in
`db/migrations/032_w2_sec1_stage1b_replay_resource_binding.sql:253-262`:

```sql
  perform internal.require_replay_principal(p_client_mutation_id);
  replay := internal.ledger_replay(p_client_mutation_id, 'messages.edit');
  if replay is not null then
    -- Security boundary: runs with ledger_replay's advisory lock HELD.
    perform internal.require_replay_principal(p_client_mutation_id);
    perform internal.require_replay_subject(
      replay #>> '{messageId}', p_message_id::text, 'message');
    return replay;
  end if;
```

**Why the principal pin is called TWICE.** The pre-check before `ledger_replay`
runs with **no lock held**: against a victim's *uncommitted* ledger row it reads
"not found", pins nothing, then blocks inside `ledger_replay` on the advisory
lock, and after the victim commits it proceeds with the comparison already
skipped. The call **inside** the branch runs with `ledger_replay`'s
`pg_advisory_xact_lock` (`016:26`) already held and has no such window. The
subject binding is only meaningful inside the branch because it needs the stored
projection. **Do not "simplify" this to one call.**

**Choosing the subject expression.** Compare the resource identifier *in the
stored projection* against the *route argument the current request names*. Its
JSON path depends on what the site stores — `{entity,space_id}`, `{messageId}`,
`{project,id}`, `{invite,id}`. Read the site's own `ledger_record` call.
A useful side effect: if the stored projection has a *different shape* (recorded
through a sibling door), the path yields `NULL`, `is distinct from` is TRUE, and
the cross-door replay is refused as well — this is how 032 closed `post_message`.

**Invite-style sites additionally need strip-at-rest + rehydrate-after-binding**
(032 sites 4-6): store the projection with the credential removed, and rebuild the
response from the live row *after* both guards pass. Note this trades
byte-identical replay for freshness, and a vanished row must RAISE, never degrade
to the stored blob.

## 6. PROOF STANDARD — XG03 is the executable template

`packages/server/test/w3/xg03-same-principal-resource-confusion.test.ts` is the
gate's test and shows what a proof of one of these fixes looks like:

1. a **negative** — same principal, cmid recorded against resource A, request
   addressing resource B — which must go from returning A's projection under 201
   to being refused; and
2. a **positive control in the same test** — same principal, same cmid, **same**
   resource — which must keep returning the stored result byte-identical.

**Both halves are required.** A guard can pass every negative ever written by
refusing everyone; the positive is what proves it *discriminates*. Equally, a
check seen only green is indistinguishable from a check that cannot fail. For a
multi-door label, the negative must be driven **through each door**, or a green
proves only that one door was closed.

## 7. FULL TABLES

### 7.1 All 63 labels — doors, grants, per-door class
Legend: `name[classG]` = class letter, `G` granted / `-` not granted.

```
label                              doors granted  protection by door
commands.undo                          1       1  undo_command[DG]
edges.create                           2       2  set_collection_item[DG]; write_edge[DG]
edges.delete                           1       1  delete_edge[DG]
edges.patch                            1       1  update_edge[DG]
entities.commands.complete             1       1  complete_task[DG]
entities.commands.linkCommit           1       1  link_commit[DG]
entities.commands.linkPr               1       1  link_pull_request[DG]
entities.commands.pull                 1       1  set_pull_state[DG]
entities.commands.work                 1       1  set_work_state[DG]
entities.create                       11      11  create_channel[DG]; create_collection[DG]; create_commit_entity[DG]; create_custom_entity[DG]; create_document[DG]; create_file_entity[DG]; create_pull_request_entity[DG]; create_skill_entity[DG]; create_spell_entity[DG]; create_task[DG]; create_team_member[DG]
entities.delete                        1       1  delete_entity[DG]
entities.move                          1       1  move_entity[DG]
entities.patch                        11      11  update_channel[DG]; update_collection[DG]; update_commit_entity[DG]; update_custom_entity[DG]; update_document[DG]; update_file_entity[DG]; update_pull_request_entity[DG]; update_skill_entity[DG]; update_spell_entity[DG]; update_task_content[DG]; update_team_member[DG]
entities.points.add                    1       1  grant_points[DG]
entities.react                         1       1  react[DG]
entities.restore                       1       1  restore_entity[DG]
entityKinds.create                     1       1  w2_create_entity_kind[DG]
entityKinds.update                     1       1  w2_update_entity_kind[DG]
execution.spawn                        1       1  execution_spawn[DG]
execution.streams.attach               1       1  grant_stream_attach[CG]
execution.transition                   1       1  work_session_transition[DG]
files.uploadAbort                      1       1  w2_abort_file_upload[DG]
files.uploadComplete                   1       1  w2_complete_file_upload[DG]
files.uploadInit                       1       1  w2_init_file_upload[DG]
handoffs.send                          1       1  w2_prepare_handoff[AG]
handoffs.withdraw                      1       1  w2_withdraw_handoff[DG]
inbox.markRead                         1       1  mark_notification_read[BG]
interactionProfiles.activate           1       1  activate_interaction_profile[DG]
interactionProfiles.propose            1       1  propose_interaction_profile[DG]
interactionProfiles.retire             1       1  retire_interaction_profile[DG]
interactionProfiles.updateDraft        1       1  update_interaction_profile_draft[DG]
interactionProfiles.validate           1       1  validate_interaction_profile[DG]
maintenance.w1.compensate              1       1  compensate_w1_foundations[DG]
maintenance.w1.repair                  1       1  repair_w1_foundations[DG]
messages.attachments.add               1       1  w2_add_message_attachments[DG]
messages.attachments.remove            1       1  w2_remove_message_attachments[DG]
messages.delete                        2       1  redact_message[D-]; w2_tombstone_message[CG]
messages.delivery.memberReset          1       1  reset_session_wake_budget_for_member_reply[DG]
messages.edit                          2       1  edit_message[D-]; w2_edit_message[CG]
messages.post                          2       1  post_message[C-]; w2_post_message_batch[BG]
placements.apply                       1       1  place_entity[DG]
projects.associations.correct          1       1  correct_project_association[DG]
projects.create                        1       1  create_project[DG]
projects.link                          2       2  link_project[DG]; link_project_w2[DG]
projects.unlink                        2       2  unlink_project[DG]; unlink_project_w2[DG]
projects.update                        2       2  update_project[DG]; update_project_w2[CG]
readMarks.upsert                       1       1  mark_read[BG]
savedViews.create                      1       1  create_saved_view[DG]
savedViews.delete                      1       1  delete_saved_view[DG]
savedViews.update                      1       1  update_saved_view[DG]
spaces.create                          1       1  create_space[DG]
spaces.defaultChannel.set              1       1  set_space_default_channel[CG]
spaces.interactionProfile.setDefault     1       1  set_space_profile_default[DG]
spaces.invites.create                  1       1  create_invite[CG]
spaces.invites.redeem                  2       2  join_public_space[CG]; redeem_invite[CG]
spaces.invites.revoke                  2       2  revoke_invite[CG]; w2_revoke_invite[CG]
spaces.menu.update                     2       1  set_space_menu_config[D-]; update_space_menu[CG]
spaces.taskAxes.create                 2       2  create_task_axis[DG]; w2_create_task_axis[DG]
spaces.taskAxes.delete                 2       2  delete_task_axis[DG]; w2_delete_task_axis[DG]
spaces.taskAxes.update                 2       2  update_task_axis[DG]; w2_update_task_axis[DG]
spaces.update                          2       2  update_space[DG]; w2_update_space[CG]
teamMembers.interactionProfile.setDefault     1       1  set_teammate_profile_default[DG]
tracking.refresh                       1       1  queue_tracking_refresh[DG]

```

### 7.2 Class D work list, grouped by label

```

  commands.undo  (1 door)
      GRANTED   undo_command(text,uuid,text)

  edges.create  (2 doors)
      GRANTED   set_collection_item(uuid,uuid,double precision,uuid,text)
      GRANTED   write_edge(uuid,uuid,text,jsonb,uuid,text)

  edges.delete  (1 door)
      GRANTED   delete_edge(uuid,uuid,text)

  edges.patch  (1 door)
      GRANTED   update_edge(uuid,jsonb,uuid,text)

  entities.commands.complete  (1 door)
      GRANTED   complete_task(uuid,integer,uuid[],uuid,text)

  entities.commands.linkCommit  (1 door)
      GRANTED   link_commit(uuid,text,text,text,text,uuid,uuid,text)

  entities.commands.linkPr  (1 door)
      GRANTED   link_pull_request(uuid,text,text,text,integer,uuid,uuid,text)

  entities.commands.pull  (1 door)
      GRANTED   set_pull_state(uuid,integer,text,uuid,text)

  entities.commands.work  (1 door)
      GRANTED   set_work_state(uuid,text,uuid,timestamp with time zone,text,text)

  entities.create  (11 doors)
      GRANTED   create_channel(uuid,text,uuid,text,uuid,double precision,text)
      GRANTED   create_collection(uuid,text,uuid,text,text,uuid,double precision,text)
      GRANTED   create_commit_entity(uuid,text,uuid,text,text,text,text,text,timestamp with time zone,uuid,double precision,text)
      GRANTED   create_custom_entity(uuid,text,text,uuid,jsonb,uuid,double precision,text)
      GRANTED   create_document(uuid,text,uuid,text,text,uuid,double precision,uuid,text,text)
      GRANTED   create_file_entity(uuid,text,uuid,text,uuid,double precision,text)
      GRANTED   create_pull_request_entity(uuid,text,uuid,text,text,text,integer,text,text,uuid,double precision,text)
      GRANTED   create_skill_entity(uuid,text,uuid,text,text,uuid,double precision,text)
      GRANTED   create_spell_entity(uuid,text,uuid,text,jsonb,uuid,double precision,text)
      GRANTED   create_task(uuid,text,uuid,text,jsonb,uuid,double precision,text,jsonb,integer,date,uuid,text,text)
      GRANTED   create_team_member(uuid,text,uuid,text,text,text,text,text,text,jsonb,jsonb,text,uuid,double precision,text)

  entities.delete  (1 door)
      GRANTED   delete_entity(uuid,uuid,text)

  entities.move  (1 door)
      GRANTED   move_entity(uuid,uuid,double precision,integer,uuid,text)

  entities.patch  (11 doors)
      GRANTED   update_channel(uuid,integer,uuid,text,text,text)
      GRANTED   update_collection(uuid,integer,uuid,text,text,text,text)
      GRANTED   update_commit_entity(uuid,integer,uuid,text,text,text,timestamp with time zone,text)
      GRANTED   update_custom_entity(uuid,integer,text,uuid,jsonb,text)
      GRANTED   update_document(uuid,integer,uuid,text,text,text,text)
      GRANTED   update_file_entity(uuid,integer,uuid,text,text,text)
      GRANTED   update_pull_request_entity(uuid,integer,uuid,text,text,text,text,text)
      GRANTED   update_skill_entity(uuid,integer,uuid,text,text,text,text)
      GRANTED   update_spell_entity(uuid,integer,uuid,text,text,jsonb,text)
      GRANTED   update_task_content(uuid,integer,uuid,text,text,jsonb,text,text,jsonb,integer,date,boolean,text)
      GRANTED   update_team_member(uuid,integer,uuid,text,text,text,text,text,text,text,jsonb,jsonb,text,jsonb,text)

  entities.points.add  (1 door)
      GRANTED   grant_points(uuid,integer,text,uuid,uuid,text)

  entities.react  (1 door)
      GRANTED   react(uuid,text,boolean,uuid,text)

  entities.restore  (1 door)
      GRANTED   restore_entity(uuid,uuid,text)

  entityKinds.create  (1 door)
      GRANTED   w2_create_entity_kind(uuid,text,text,jsonb,jsonb,uuid,text)

  entityKinds.update  (1 door)
      GRANTED   w2_update_entity_kind(uuid,text,jsonb,uuid,text)

  execution.spawn  (1 door)
      GRANTED   execution_spawn(uuid,uuid,uuid[],uuid,text,text,text,text,text,text,text,text,boolean,integer,uuid,text)

  execution.transition  (1 door)
      GRANTED   work_session_transition(uuid,text,integer,text,uuid,text)

  files.uploadAbort  (1 door)
      GRANTED   w2_abort_file_upload(uuid,text)

  files.uploadComplete  (1 door)
      GRANTED   w2_complete_file_upload(uuid,bigint,text,text,uuid[])

  files.uploadInit  (1 door)
      GRANTED   w2_init_file_upload(uuid,uuid,uuid,text,text,bigint,text,uuid,text,timestamp with time zone,uuid,bigint,text,text)

  handoffs.withdraw  (1 door)
      GRANTED   w2_withdraw_handoff(text,integer,text,uuid,text)

  interactionProfiles.activate  (1 door)
      GRANTED   activate_interaction_profile(uuid,integer,text,boolean,text)

  interactionProfiles.propose  (1 door)
      GRANTED   propose_interaction_profile(uuid,jsonb,uuid,text)

  interactionProfiles.retire  (1 door)
      GRANTED   retire_interaction_profile(uuid,integer,boolean,text)

  interactionProfiles.updateDraft  (1 door)
      GRANTED   update_interaction_profile_draft(uuid,integer,jsonb,uuid,text)

  interactionProfiles.validate  (1 door)
      GRANTED   validate_interaction_profile(uuid,integer,text)

  maintenance.w1.compensate  (1 door)
      GRANTED   compensate_w1_foundations(uuid,text)

  maintenance.w1.repair  (1 door)
      GRANTED   repair_w1_foundations(uuid,text)

  messages.attachments.add  (1 door)
      GRANTED   w2_add_message_attachments(uuid,uuid[],integer,uuid,text)

  messages.attachments.remove  (1 door)
      GRANTED   w2_remove_message_attachments(uuid,uuid[],integer,uuid,text)

  messages.delete  (1 door)
      no-grant  redact_message(uuid,uuid,text)

  messages.delivery.memberReset  (1 door)
      GRANTED   reset_session_wake_budget_for_member_reply(uuid,text)

  messages.edit  (1 door)
      no-grant  edit_message(uuid,text,integer,jsonb,uuid,text)

  placements.apply  (1 door)
      GRANTED   place_entity(uuid,uuid,text,text,double precision,uuid,text)

  projects.associations.correct  (1 door)
      GRANTED   correct_project_association(uuid,uuid,integer,text)

  projects.create  (1 door)
      GRANTED   create_project(text,text,text,text,jsonb,text)

  projects.link  (2 doors)
      GRANTED   link_project(uuid,uuid,uuid,text)
      GRANTED   link_project_w2(uuid,uuid,uuid,text)

  projects.unlink  (2 doors)
      GRANTED   unlink_project(uuid,uuid,text)
      GRANTED   unlink_project_w2(uuid,uuid,text)

  projects.update  (1 door)
      GRANTED   update_project(uuid,text,text,text,text,jsonb,text)

  savedViews.create  (1 door)
      GRANTED   create_saved_view(uuid,text,text,jsonb,jsonb,uuid,text)

  savedViews.delete  (1 door)
      GRANTED   delete_saved_view(uuid,uuid,text)

  savedViews.update  (1 door)
      GRANTED   update_saved_view(uuid,text,text,jsonb,jsonb,uuid,text)

  spaces.create  (1 door)
      GRANTED   create_space(text,text,text,text,text)

  spaces.interactionProfile.setDefault  (1 door)
      GRANTED   set_space_profile_default(uuid,uuid,integer,boolean,text)

  spaces.menu.update  (1 door)
      no-grant  set_space_menu_config(uuid,integer,jsonb,integer,text)

  spaces.taskAxes.create  (2 doors)
      GRANTED   create_task_axis(uuid,text,text[],text,integer,text)
      GRANTED   w2_create_task_axis(uuid,text,text[],text,integer,uuid,text)

  spaces.taskAxes.delete  (2 doors)
      GRANTED   delete_task_axis(uuid,text)
      GRANTED   w2_delete_task_axis(uuid,uuid,text)

  spaces.taskAxes.update  (2 doors)
      GRANTED   update_task_axis(uuid,text,text[],integer,text)
      GRANTED   w2_update_task_axis(uuid,uuid,text,text[],text,integer,text)

  spaces.update  (1 door)
      GRANTED   update_space(uuid,text,text,text,text,text)

  teamMembers.interactionProfile.setDefault  (1 door)
      GRANTED   set_teammate_profile_default(uuid,uuid,integer,text)

  tracking.refresh  (1 door)
      GRANTED   queue_tracking_refresh(uuid[],uuid,text)
```

---

## 8. BOUNDARY OF THIS DOCUMENT

- **Measured on the 32-file chain, identity `f7a9e137f01226f3`** (my own reading,
  not adopted from an announcement). It was first taken on the 31-file chain
  (`7e42a0d58f7b555d`) and RE-VERIFIED after 035 landed: the set of live
  `ledger_replay` callers and their `tm8_app` grants came back **byte-identical**,
  98 callers / 94 granted, so 035 moved nothing in this document. That re-check was
  run rather than reasoned — 035 is a grant-and-policy migration and it would have
  been reasonable to assume it could not touch function grants, but assuming is how
  three wrong answers got into this program today.
- Re-measure after any rotation with
  `cd db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16` (the `cd`
  is load-bearing — `shasum` hashes its own output lines, which carry the path as
  typed).
- **Class E is unadjudicated.** Nothing is cleared as non-disclosing.
- **`entities.patch` (11 doors, all granted) is class D and UNMEASURED.** It was
  explicitly declined as scope, *not* judged safe. It is the largest single item
  in the backlog and structurally identical to `entities.create`.
- Grant status is a DB-layer claim. Only the `entities.create` confusion is
  measured at the HTTP boundary.
