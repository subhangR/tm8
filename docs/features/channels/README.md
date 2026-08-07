# Channels

The channel work from task `019fd744` ("feature/Channels", Bhargav, 2026-08-06)
and the three designs it split into.

| Document | What it decides |
|---|---|
| [`CHANNEL-MEMBERS-DESIGN.md`](CHANNEL-MEMBERS-DESIGN.md) | Channel membership as a graph edge — schema, contract, UI |
| [`CHANNEL-STATUS-DESIGN.md`](CHANNEL-STATUS-DESIGN.md) | `active · paused · done`, and why it is not the tombstone |
| [`SLACK-IMPORT-DESIGN.md`](SLACK-IMPORT-DESIGN.md) | Importing and syncing Slack channels and messages |

## What the ticket asked for, and where each item went

The ticket is eight numbered items. Read as a whole they describe a channel
wearing a task's clothes, plus three things a channel does not have yet.

| # | Item | Outcome |
|---|---|---|
| 1 | No State, Priority, Assigned when creating a channel | **Fixed by [#42]** — see below |
| 2 | Archiving comes after creating, not during | **Already true** — see below |
| 3 | Task description makes no sense for a channel | **Shipped** — replaced by an optional Topic |
| 4 | A channel has members, addable on create/update | **Deferred** → `CHANNEL-MEMBERS-DESIGN.md` |
| 5 | No acceptance criteria, subtree, Runs | **Fixed by [#42]** |
| 6 | No "attach a file" when creating | **Fixed by [#42]** |
| 7 | "Copy the exact flow of channel creation for a channel" | **Shipped** — instant create + a Slack-style edit dialog |
| 8 | Import and sync Slack channels/messages over MCP and sockets | **Deferred** → `SLACK-IMPORT-DESIGN.md` |
| — | Channels need states/statuses (added 2026-08-07) | **Deferred** → `CHANNEL-STATUS-DESIGN.md` |
| — | Subchannels in the UI (added 2026-08-07) | **Shipped** — `add-child` wired |

### Items 1, 5 and 6 were one defect, and it was not a channel defect

`＋ New` was the same hook on every kind screen and it called
`commands.createTask`, which sends `kind: 'task'` unconditionally. **`＋ New
channel` created a task.** Everything the reporter listed — State, Priority,
Assigned, the description, acceptance criteria, the subtree, Runs, the
attachment strip — is what a TASK panel draws. None of it was ever declared on
the channel registry row, which has been `archetype: 'hub'` with no state
control, no value controls and no assign control the whole time.

[#42] fixed the create (and two further defects stacked behind it: the
`channels.name` grammar, and the unique-per-space placeholder collision). A
probe render of `EntityDetailPanel` over the channel fixture at `7631e08`
confirms what is left on screen:

```
TESTIDS: entity-detail-panel · panel-header · panel-toolbar · panel-tabs
         panel-action-bar · hub-body · hub-description · hub-pinned · hub-tabs
BUTTONS: Channel · Discussion · Connections · Activity · ⤢ · ✕
```

No state, no priority, no assignee, no acceptance, no subtree, no Run, no
attachment strip. Items 1, 5 and 6 need no further work.

### Item 2 was already true

"Archiving a channel comes after creating the channel." It does. Archive is the
shared tombstone (`entities.delete` / `deletedAt`), it lives in
`EntityControlStrip` on the expanded list row, and the channel panel does not
mount that strip at all — `controlsFor()` is false for a kind with no state,
value or assign control. A probe of the row strip at `7631e08`:

```
State — no state · "Channel has no state to set on this node …"   (disabled)
Archive                                                            (live)
```

So archive is reachable on an existing channel and absent from the create flow,
which is exactly what the item asked for. The `State — no state` line above it
is what prompted the follow-up ruling that channels should have real statuses —
see `CHANNEL-STATUS-DESIGN.md`.

### What items 3 and 7 turned into

Topic was READABLE and not WRITABLE. `HubBody` has rendered `content.topic` as
the channel's standing description since the archetype landed, `channels.topic`
is a real column, and `update_channel(p_topic)` is a real RPC parameter — and
no client call ever filled it. There was no surface in the app that could edit
a channel's topic.

The shipped answer is a **registry-driven edit dialog**:

- `KindConfig.editFields` — registry DATA naming each editable field, its
  target (`title` or a `content` member), whether it is required, and its
  grammar.
- `EditEntityDialog` — ONE component that draws whatever it is handed. It has
  to be generic: `src/authoring/` is scanned by `no-kind-literals.test.ts`,
  which fails the build on the string `'channel'` appearing in that lane.
- `edit` — a new `ActionRef`, in the channel's `panel.primaries`.

The channel declares Name (required, slug grammar) and Topic (**optional** —
`channels.topic` is `not null default ''`, so an omitted topic is a value the
database already stores). Members become one more entry in that array once the
edge lands, not a second dialog.

Create is unchanged and stays instant: `＋ New channel` commits a legal, unique
placeholder immediately and opens the panel with the name in inline edit. The
dialog is the EDIT surface, not a pre-commit form — cancelling it leaves
nothing behind.

### Subchannels were a wiring gap, not a schema one

`add-child` has been declared on the `channel` and `doc` registry rows since
they were written, and it rendered disabled-with-reason on every panel in the
app the entire time: **no host ever passed an `onAction` at all.** The graph was
always ready — `entities.parentId` is kind-agnostic and the channel row already
declares `tree: { by: 'hierarchy', guideLines: true }`.

Wiring it surfaced a second defect worth recording, because it is the honesty
rule failing in the direction nobody was watching. `ActionBar`'s check was
`if (!onAction)` — correct while NO host passed one, and a lie the instant one
did: wiring `edit` would have lit up `add-child` beside it as a live button
dispatching into a switch with no arm for it. `wiredActions` is the fix, and it
is derived from the handler map so the advertised set cannot drift from the
implemented one.

## Why the three deferrals are the same shape

Members, statuses and Slack all need **schema + contract + server + UI**, and
none of them can be finished by a UI-only change. That matters operationally on
this box: `tm8-staging-ui.service` is vite dev on source, so a pure `tm8-ui`
change ships with a `git checkout` — but the server half needs a
`systemctl restart` that no agent here can perform.

[#42]: https://github.com/subhangR/tm8/pull/42
