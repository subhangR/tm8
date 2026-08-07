# Channel statuses

**Status:** designed, not built. Raised and scoped by user ruling 2026-08-07
during task `019fd744`.

> "we need state / statuses for channel as well, they should be archivable,
> with different properly defined states/statuses, and can be moved to done, or
> completed something like that."

## Where this came from

The channel's expanded list row draws a State line that refuses:

```
State   no state
        "Channel has no state to set on this node — the contract records no
         status field for this kind, so nothing could be written"
Archive                                                          (live)
```

That refusal is **truthful** — there is no status column — and the ruling is
that there should be one, rather than that the line should be hidden.

## The two axes are different, and conflating them is the trap

| | Status | Tombstone |
|---|---|---|
| Stored as | new `channels.status` column | `entities.deleted_at` |
| Vocabulary | `active` · `paused` · `done` | present / absent |
| Verb | `set-state` | `archive` / `restore` |
| Meaning | what is happening in this channel | is this channel filed away |

A channel can be **done and still readable**, then archived later. Folding
"done" into the tombstone would make finishing a channel's work and hiding it
the same act, which is exactly the thing that cannot be undone selectively.
Archive already works on channels today and is unaffected by this design.

## Vocabulary (user-selected 2026-08-07)

- **`active`** — default; the channel is in use.
- **`paused`** — nothing is happening, keep it.
- **`done`** — the work this channel existed for is finished.

Deliberately NOT the task vocabulary. `open · pulled · working · in_review ·
blocked · done · cancelled` was the cheaper option — the machinery exists and
the tiers light up for free — and it imports a category error: a conversation
is not "in review". Item 1 of the ticket was a complaint about exactly that
kind of borrowing.

## Design

### 1. Schema

```sql
alter table public.channels
  add column status text not null default 'active'
  check (status in ('active','paused','done'));
```

`not null default 'active'` so every existing channel is `active` with no
backfill, and no read has to handle a null.

### 2. Server

- `update_channel` gains `p_status text default null`, COALESCEd like `p_name`
  and `p_topic` (007:1095) so a patch that omits it does not clear it.
- The task-side rule that `done` may only be written by `complete_task`
  (038:378, 060:34) **must not** be copied here. A channel has no acceptance
  criteria to gate on, so a completion verb would be a gate over nothing.
  `set_work_state`-style writing from any value to any value is right for this
  kind, and the registry's own comment already records that this node enforces
  no transition matrix.
- `ChannelState` (contract.ts:109) grows `status`.

### 3. UI — mostly registry data

- `channel.list.stateControl` gains the three options, which is what replaces
  the "no state" refusal with a real picker on the row AND in the panel
  (`controlsFor()` starts returning true, so the channel panel grows the
  control strip — including its Archive, which is currently row-only).
- `channel.chip.tintBy` moves from `'none'` to `'workStatus'`-equivalent, with
  tones per value.
- `channel.list.lifecycle` moves from `statelessTiers()` to real tiers:
  `Open` = `status in (active, paused)`, `Done` = `status = done`,
  `Archived` = `deleted: 'only'`. The `Done` tier currently renders honestly
  empty with `NO_DONE_REASON`; this is what makes it real.
- `panel.statusPill` gains a source so the header pill shows it.

Every one of those is a registry field that already exists for `task` — this is
data, not new components.

## Acceptance criteria

1. A migration adds `channels.status` with the three-value check and the
   `active` default; existing channels read back `active`.
2. `update_channel` writes status, and COALESCEs an omitted one.
3. `ChannelState.status` reaches the client; the row and panel draw a live
   picker instead of the "no state" refusal.
4. The channels list's Open / Done / Archived tiers each return the right rows,
   proven against a real DB.
5. A `done` channel is still readable and still postable-to; archiving it is a
   separate, later act.
6. Status is writable from any value to any value — no transition matrix.

## Deployment note

Server change; see the note in `CHANNEL-MEMBERS-DESIGN.md`.
