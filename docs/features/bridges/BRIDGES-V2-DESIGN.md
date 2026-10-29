# Bridges v2 — every setting on screen, memories and loops on a bridge, and a WhatsApp command set that can run a team

**Status:** DESIGN v2 · 2026-10-29 · task `01a1889e-d435-7b99-ac66-9e00425a3bcc`
**Extends:** [`BRIDGE-ENTITY-DESIGN.md`](./BRIDGE-ENTITY-DESIGN.md) (v1, 2026-10-28; final v3, 2026-10-29, which folds v1's Q1–Q6 into decisions D14–D19 and points to this doc wherever v2 changes it). Everything in v1 stands unless a section here says it changes. Section references like "v1 §2.3" point into that doc.
**Basis:** `origin/main` @ `cfb4622b4` (`integrations/whatsapp-bridge/src/{core,text,http,admin,forms,briefing,config}.ts`), the deployed copy in `prod-data/wa-bridge/src` (2026-10-20, same command set, no `forms.ts`), the loop executor (`packages/server/src/scheduler/jobs/loops.ts`, migrations 091/348/375), the launch defaults (`packages/contract/src/launch-defaults.ts`: `remembers` / `equips`), and `execution.spawn` (`tm8 help session spawn`).
**Scope:** design only. No code.

> The ask (Subhang, 29 Oct, from WhatsApp): *"explain the ui on the bridge entity and the bridge settings … i want these to be good ui where user can configure everything"* → *"yes, fill the gaps, also the bridge can have linked memories and loops, and also the WhatsApp tools that are provided to the user should be modified and robust, to spawn multiple workers, and everything what are the WhatsApp commands."*
>
> Standing decision from the same conversation: numbers belong to the member who links them and are shared into spaces; there are no space-owned numbers. If that member unshares the number or leaves the space, its bridges stop.

---

## 0. The design in one page

| Part | What v2 adds | Section |
|---|---|---|
| **UI gaps** | Six screens v1 left out: *History & retention*, the *What crosses to WhatsApp* choice in setup, *Pause / Resume / Remove* on the bridge itself, a *Test it* step and test button, a *confirm-the-consequence* dialog before any trust or access change, and a *mobile link flow* plus a reserved *Secrets* slot. A settings matrix proves every bridge field has exactly one home on screen. | §1 |
| **Memories on a bridge** | A bridge `remembers` memories (the same edge teammates and tasks use). They ride every turn and every worker the bridge starts, and they move with the bridge, not with its target. Members can propose one from WhatsApp with `/remember`; it becomes live only after a human accepts it in tm8. | §2.1 |
| **Loops on a bridge** | A loop whose subject is a bridge posts into the conversation on a schedule: *agent loops* (spawn a worker: "every weekday 9:00, post the stand-up") and *message loops* (no agent, a fixed reminder). Pausing the bridge suspends them, moving it keeps them, removing it disables them. | §2.2 |
| **Command inventory** | Every way a WhatsApp user drives the bridge today, read from code: 5 slash commands, 5 addressing forms, 4 implicit inputs, 4 status reactions, 14 agent-side HTTP doors, 15 operator CLI verbs — and the 12 weaknesses that make it brittle. | §3 |
| **Command redesign** | Commands run **on the server**, as the linked member, through the same catalog operations the UI uses: never routed to an agent, always answered, idempotent on the WhatsApp message id. A `/work` command starts **several workers from one message**; a **launch queue** absorbs the space's 64-session cap instead of failing; `/workers`, `/status`, `/tell`, `/stop`, `/result`, `/retry` manage them from a phone. | §4 |

**Five decisions** (full list §6):

1. **Memories and loops attach to the bridge, not to its target.** The group's knowledge and schedule belong to the group; retargeting keeps them. (V1)
2. **Nothing that persistently changes agent behaviour goes live from WhatsApp alone.** `/remember` and agent `/loop` create *proposals* a human accepts in tm8 (v1 D9, extended). Message-only reminders are the one exception, capped. (V3)
3. **Commands are server code, not prompts.** A command is parsed and executed by the bridge layer with the linked member's own authority; an agent never sees it. (V4)
4. **Many workers is one request, many tasks, one queue.** `/work` makes one parent task with one child per line, then hands each to the launch queue; capacity is a wait, not an error. (V5)
5. **Every message gets an answer.** A command the bridge cannot run says why in one line; a silently dropped message is a bug. (V6)

---

## 1. Filling the UI gaps

v1 §4 gave the bridge two homes — **Settings → Bridges** (connections, the list, the add wizard) and **the bridge panel** (Conversation · People · Routing · Health · Connections). Reading them back against "the user can configure everything" found six gaps. Each is closed below with its mockup; §1.7 then checks every field.

v2 panel tabs, in order: **Conversation · People · Routing · Memory · Loops · Health · Connections**. *Memory* and *Loops* are §2. *History & retention* is a section of Routing, not a tab: it is a policy, and a tab per policy would scatter them.

### 1.1 Gap 1 — History & retention

v1 had `retentionDays` in the content and "*Also import the last N days*" as Q4, but no screen. Both go into the wizard's last settings step and into Routing.

```
┌ Routing ▸ History & retention ──────────────────────────────────────────────────────────────┐
│ KEEP MESSAGES                                                                               │
│   (•) Forever                                                                               │
│   ( ) For [ 90 ▾] days, then delete them here       ⓘ WhatsApp keeps its own copy           │
│   Applies to messages, voice transcripts and media from this group. Tasks, docs and         │
│   memories made from them are not deleted.                                                  │
│                                                                                             │
│ IMPORT EARLIER MESSAGES                                                                     │
│   Last import: none                                                                         │
│   [ Import last [ 7 ▾] days ]   ⓘ Imported messages are logged only — nothing is answered,  │
│                                    no agent runs. Safe to repeat: duplicates are skipped.   │
│   During import:  ▓▓▓▓▓▓▓░░░  1,240 of ~1,800 · 14 media · [Stop]                           │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

Rules:
- **Shortening retention asks first** (§1.5): "*This deletes 3,412 messages older than 30 days from tm8 now. Search and agents will no longer see them.*" Lengthening it does not.
- **Import is a job, not a call.** `bridges.history.import {days}` starts a server job that asks the runtime for history (`history.fetch` frame, new; WhatsApp *history sync* from the linked device, Slack `conversations.history`), writes messages with `message_origins` and `routed: false`, and reports progress on `bridge.health` events. Idempotent on external ids (v1 §2.3), so repeating it is safe. The provider sheet (v1 §5) gains `history: 'full' | 'recent' | 'none'`; the button is disabled with the reason where the provider has none.
- Defaults (v1 Q2 stands): forever for groups, 90 days for DM bridges.

### 1.2 Gap 2 — "What crosses to WhatsApp" in setup

`policy.outbound: 'replies' | 'all'` existed in v1's model but the wizard's step 3 did not show it. It is the setting people most often get wrong (an agent's whole internal chatter appearing in a family group), so it gets its own plain-words row with an example, in the wizard and in Routing:

```
┌ Add bridge · 3 of 4 · Where it lands and how it behaves ────────────────────────────────────┐
│ Lands in:  💬 Infra main (Opus)                                              [Change]       │
│                                                                                             │
│ WHEN DOES TM8 ANSWER?                                                                       │
│   (•) Only when someone writes @tm8 or replies to tm8      ( ) Every message                │
│                                                                                             │
│ WHAT FROM TM8 GOES BACK TO WHATSAPP?                                                        │
│   (•) Only answers to the group          e.g. tm8's reply to "@tm8 is the deploy done?"     │
│   ( ) Everything posted in Infra main    e.g. also your own notes and agents' updates there │
│                                                                                             │
│ WHICH WAY DO MESSAGES FLOW?   (•) Both ways   ( ) WhatsApp → tm8 only   ( ) tm8 → WhatsApp  │
│ WHO CAN START AGENTS?         (•) Linked people only   ( ) Anyone in the group  ⚠ asks first │
│ HOW REPLIES ARE SIGNED        (•) "tm8:" / "Release notes (keen-otter):"   ( ) No prefix     │
│ STYLE                         [ short and readable: lead with the answer…            ] 64/300│
│                                                                                             │
│ ▸ History & retention   (forever · no import)                                               │
│                                                                    [Back]  [Next: Test it]  │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

The step's defaults come from the target kind (v1 §2.2); a channel target pre-selects *Everything posted in #deploys* and says so.

### 1.3 Gap 3 — Pause, resume and remove on the bridge

v1 put the lifecycle only on the Settings row. The bridge panel header gets a status pill that is also the control, and a `⋯` menu:

```
┌ ◍ Infra · WhatsApp ─────────────────── ● live ▾ · 14 in group · bridged to 💬 Infra main  [⋯] ┐
                                         ├──────────────────────────────┐   ├─────────────────────┐
                                         │ ⏸ Pause bridge               │   │ Move to another …   │
                                         │   Messages are still logged; │   │ Send a test message │
                                         │   nobody is answered, nothing│   │ Copy bridge id      │
                                         │   is sent. Loops wait.       │   │ ───────────────     │
                                         │ ⏸ Pause for [1 hour ▾]       │   │ Remove bridge…      │
                                         └──────────────────────────────┘   └─────────────────────┘
```

- **Pause** keeps logging inbound (so nothing is lost) and stops routing, outbound and loops. *Pause for…* (1 h, 8 h, until tomorrow 9:00) sets `pausedUntil`; the server resumes it. The pill reads *◌ paused until 18:00* — colour and word.
- **Resume** is the same pill. It shows what waited: "*12 messages arrived while paused. They are logged, not answered.*" with *[Answer the last one]* (routes one message — never a blind replay).
- **Remove** is a typed-name confirm:

```
┌ Remove the Infra bridge? ───────────────────────────────────────────────────────────────────┐
│ • The WhatsApp group is not touched. tm8 stops reading and writing it.                      │
│ • 3,412 logged messages:   (•) keep them here, read-only   ( ) delete them                  │
│ • 2 loops post here:        they will be turned off (you can point them elsewhere later)    │
│ • 3 memories are linked:    they stay in the space, unlinked from this bridge               │
│ • 4 live workers started here keep running; they just can't post to WhatsApp any more.      │
│ Type  Infra  to confirm: [            ]                              [Cancel] [Remove]      │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

All three are the v1 operations (`bridges.pause|resume|remove`); `pause` gains an optional `until`. Remove stays human-only.

### 1.4 Gap 4 — "Test it"

A bridge that silently does nothing is the most common Phase-1 failure (wrong group, a trust list that excludes the owner, a logged-out device). The wizard gets a fourth step, and Health keeps the same button forever.

```
┌ Add bridge · 4 of 4 · Test it ──────────────────────────────────────────────────────────────┐
│  ✓ Connected to WhatsApp +91 ···· 9494                                         0.4 s        │
│  ✓ tm8 can read "Infra" (14 people)                                                         │
│  ✓ Sent a test message to the group          "tm8: this group is now connected to tm8 ✓"    │
│  ◌ Now send  @tm8 ping  from your phone…     waiting 0:23                                    │
│      ✓ received from Subhang (linked ✓) → Infra main answered "pong" in 2.1 s                │
│                                                                                             │
│  ( ) Don't post the test message (quiet setup)                                              │
│                                                          [Back]  [Skip test]  [Finish]      │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

Each line is a server-side check with its own failure words ("*the number is not in this group any more*", "*the message arrived but you are not allowed to start agents here — change 'Who can start agents' or link your number*"). `bridges.test` runs checks 1–3; the round trip uses the real inbound path, so a pass means the real thing works. *Finish* is allowed after a failure — the bridge is created `degraded` with the reason on Health.

### 1.5 Gap 5 — Confirm the consequence before trust or access changes

Phase 1 said "*turning trust on is an access change: the operator confirms it in the tm8 UI first*" but had no UI. v2 has one rule: **a change that widens who can do what, or deletes data, shows its consequence in numbers and needs a second click.** It is one dialog component, fed by a server dry run (`bridges.update --dry-run` returns a `consequences[]` list), so the words are computed, not guessed in the UI.

| Change | What the dialog says |
|---|---|
| *Who can start agents* → **Anyone** | "*31 people in Gaming, 29 of them not linked, will be able to start agents that run as Opus and spend from the space's credits.*" |
| *When tm8 answers* → **Every message** | "*Gaming had 412 messages last week. Each one would start a turn.*" (measured from the log) |
| *What goes back* → **Everything** | "*Everything posted in Gaming main — including agents' working notes — will appear in WhatsApp.*" |
| *Direction* → **tm8 → WhatsApp only** | "*Nothing from the group will reach tm8; you won't see replies.*" |
| People → **This is \<member\>** (assert) | "*Messages from +91 ···· 0001 will appear as Rahul in this space and can start agents. Shown as 'asserted', not verified.*" |
| Retention shortened | §1.1 |
| Move to another target | "*Infra main stops getting this group. 2 loops and 3 memories move with the bridge. 4 live workers keep their handles.*" |
| Connection *unshare* / owner leaves the space | "*5 bridges in this space stop: Infra, Gaming, …*" (the standing decision above, now visible) |

Narrowing changes (anyone → linked, every → mention) apply at once with an *Undo* toast.

### 1.6 Gap 6 — Mobile linking, and the slot for shared secrets

**Mobile link flow.** v1 said "*QR is desktop-first (the phone is the other device)*". On a phone the QR cannot be scanned by the phone that shows it. The mobile flow uses WhatsApp's **pairing code** instead, with a hand-off for the QR when a second screen exists:

```
┌ Link a WhatsApp number ───────────┐      ┌ Link a WhatsApp number ───────────┐
│ Which phone has the number?       │      │ On the phone with +91 ···· 9494:  │
│ (•) This phone                    │      │ 1 WhatsApp → Settings → Linked    │
│ ( ) Another phone                 │      │   devices → Link a device         │
│                                   │      │ 2 "Link with phone number instead"│
│ Number: [+91 98xxx xxx94       ]  │      │ 3 Enter:                          │
│                                   │      │        K7Q2 - 9MXD    [Copy]       │
│ [Get a code]                      │      │        expires in 2:41            │
│                                   │      │                                   │
│ On a computer instead? Show a QR: │      │ ◌ waiting for WhatsApp…            │
│ [Open on another device ↗]        │      │ [Switch to QR]  [Cancel]           │
└───────────────────────────────────┘      └───────────────────────────────────┘
```

- *Open on another device* mints a one-use, 5-minute hand-off link (member-addressed, like the QR event in v1 §3.6) that opens the QR page on a laptop already signed in as the same member. The link carries no secret; it only says "show me my pending QR".
- The pairing code rides the existing `bridge.connection.auth` event (`pairingCode` was already in v1's frame). Nothing is stored.
- Every step of the add-bridge wizard is single-column on mobile; the conversation picker searches as you type.

**Shared secrets slot.** The "resource" idea (encrypted API keys and phone numbers shared into a space) is its own saved task and not designed here. v2 reserves its place so it arrives without a re-layout: the connection row's `⋯` menu gets *Shared with spaces…* (today: the v1 offer/withdraw list), and Settings → Bridges' *Connections* header is titled **Accounts & secrets**, with the secrets list rendering "*coming soon — tracked in the Resources task*" until that work lands. Bridges keep using connections; nothing in this design depends on the resource model.

### 1.7 Every setting has a home

The check behind "*configure everything*": each field a human can set, where it is set, and who may set it. Nothing is file-only or CLI-only.

| Field | Wizard step | Bridge panel | Settings → Bridges | CLI | Who |
|---|---|---|---|---|---|
| connection (number/workspace) | 1 | Health (read) | Connections | `bridge connection …` | owner |
| conversation | 2 | header (read) | list row | `--conversation` | admin |
| target | 3 | Routing → *Move* | row → panel | `bridge retarget` | admin, human |
| `trigger` | 3 | Routing | — | `--trigger` | admin |
| `outbound` | 3 (§1.2) | Routing | — | `--outbound` | admin |
| `direction` | 3 | Routing | — | `--direction` | admin |
| `whoMayTrigger` | 3 | Routing (§1.5 confirm) | — | `--who-may-trigger` | admin, human |
| `voice` | 3 | Routing | — | `--voice` | admin |
| `style` | 3 | Routing | — | `--style` | admin |
| retention / import | 3 ▸ | Routing → History (§1.1) | — | `bridge update --retention-days`, `bridge import` | admin, human |
| pause / resume / remove | — | header (§1.3) | row `⋯` | `bridge pause|resume|remove` | admin |
| people: mute, assert, invite, unlink | — | People | — | `bridge people|assert|invite` | admin |
| my own link | — | People → *This is me* | — | `bridge link begin` | the member |
| handles | — | Routing → Handles | — | `bridge handles` | read: member |
| memories | — | Memory (§2.1) | — | `bridge memory add|remove` | admin; propose: linked |
| loops | — | Loops (§2.2) | — | `entity create loop --subject <bridge>` | admin; reminders: linked |
| command policy (§4.6) | — | Routing → *Commands* | — | `--commands …` | admin |
| worker defaults (§4.3) | — | Routing → *Workers* | — | `--default-teammate`, `--default-project`, `--max-workers` | admin |
| test | 4 | Health → *Send test* | row `⋯` | `bridge test` | admin |

---

## 2. Linked memories and loops

### 2.1 Memories on a bridge

**Model.** A bridge may `remembers` any number of `memory` entities in its space — the same edge a teammate or a task uses (`launch-defaults.ts`: `via 'teammate' | 'task'`). One memory may be remembered by several bridges ("our deploy windows" in Infra and in Ops). `remembers` gains `bridge` in its `src_kinds`; no new table.

**Effect.** A bridge's memories are injected wherever the bridge is the reason an agent is working:

| Where | How |
|---|---|
| a **chat-target turn** started by a routed message | the turn's context index gets the bridge's memories after the chat teammate's own (the chat runtime already builds a working set per turn) |
| a **worker** started from the bridge (`/work`, the main chat's spawn with the bridge in its lineage, a bridge loop) | `launch.defaults` gains `via: 'bridge'`: the server walks `launched_by` (330) up to the bridge's target, and adds the bridge's memories — pre-ticked on the launch sheet, so a human sees them |
| a **session target** | delivered messages carry no memory (a running session's working set is fixed); the Memory tab says so |
| a **channel target** | n/a — nobody answers by default |

The budget meter is unchanged: bridge memories are measured like any default (`promptBytes`) and count against the memory group's budget, ordered after the teammate's and task's, so a long bridge memory list cannot crowd out the teammate's own.

**UI — the Memory tab.**

```
┌ Memory ─────────────────────────────────────────────────────────────── [+ Link a memory] ┐
│ Agents working for this group carry these.            3 linked · 1.9 KB of a 6 KB budget │
│                                                                                           │
│  🧠 Deploy windows are Tue/Thu 14:00–16:00 IST          from Infra · 12 Oct   [Unlink]    │
│  🧠 Rahul owns the billing service; ask him first      linked by Subhang     [Unlink]    │
│  🧠 Reply in Hinglish when asked in Hinglish           from WhatsApp ✓       [Unlink]    │
│                                                                                           │
│ PROPOSED FROM WHATSAPP                                                                    │
│  ? "the staging db password rotates on Mondays"        Rahul (linked) · 10:41             │
│      ⚠ mentions a password — accept only if it holds no secret      [Accept] [Edit] [Drop]│
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

**From WhatsApp.** `/remember <text>` (§4) creates a memory **draft** with `authored_from → bridge`, linked to the bridge by a `proposed` flag on the edge's metadata, and raises an `fyi` attention request to the bridge's admins: *Rahul proposed a memory for Infra*. It is injected nowhere until a human accepts it in tm8 (v1 D9's reasoning: a memory is a *persistent prompt*; a stranger who can write one can steer every future agent in the group). The secret-pattern scanner (`guard_manifest_secrets`) runs on proposals; a hit is flagged, not silently dropped. `/memories` lists the accepted ones; `/forget <n>` by a linked member creates an *unlink proposal* the same way.

A per-bridge switch *Accept memories from linked members without review* exists, is off by default, is admin-only, human-only, and goes through §1.5's confirm. It never applies to guests.

**Permissions.**

| Action | Who |
|---|---|
| link / unlink a memory (UI, CLI) | space admin; the memory's own author may unlink theirs |
| propose (`/remember`, `/forget`) | linked members where `whoMayTrigger` admits them; never guests |
| accept / drop a proposal | space admin, human-only |
| read the list | any member who can read the bridge; in WhatsApp, any sender allowed to trigger |

### 2.2 Loops on a bridge

**Model.** A `loop` whose `subjectId` is a bridge (the loop content already has `subjectId`, `schedule`, `teamMemberId`, `prompt`, `config`). Two flavours, chosen by `config.bridge.action`:

| | **Agent loop** (`action: 'agent'`) | **Message loop** (`action: 'message'`) |
|---|---|---|
| Example | "*Every weekday 9:00, post yesterday's merged PRs and today's blockers.*" | "*Every Sunday 20:00: 'Reminder — papers due Monday'.*" |
| On firing | the existing executor path: derive a task from the subject, spawn a session (`triggered_by` the loop), with the bridge's memories (§2.1) and a bridge handle; the session posts its result with `tm8 message send --to <bridge>` | **no session**: the executor posts `config.bridge.text` on the bridge's log anchor as the loop (author: the bridge, `via: {loopId}`), which crosses as `tm8: …` |
| Cost | a session per firing | none |
| Overlap guard | the executor's (previous session live → skip) | n/a |
| Created from WhatsApp | proposal only (§4.4 `/loop`) | directly, by a linked member (`/remind`), capped at 10 live per bridge |

`config.bridge` also carries `quietHours` (no posts 22:00–08:00 in the bridge's timezone unless the loop says otherwise), `onlyIfNew` (agent loops: the session is told to post nothing if nothing changed — "*no news*" messages are filler, the Phase-1 watchdog lesson) and `replyTo: 'none' | 'last'`.

The executor change is small: a `message` action branch beside the spawn branch in `loops.ts`, plus a pre-check that reads the subject bridge's `status`. Message loops keep the misfire rule (**skip, never backfill**): a reminder that missed its minute is gone, and the Loops tab shows *missed 1 · node was down*.

**UI — the Loops tab.**

```
┌ Loops ──────────────────────────────────────────────────────────────────── [+ New loop] ┐
│  ⟳ Daily stand-up             weekdays 09:00   agent · Opus        next 09:00 tomorrow   │
│     last: 09:00 today ✓ posted · 1 session · 3.2k tokens                  [⏸] [Edit] [⋯]  │
│  ⟳ Papers reminder            Sun 20:00        message            next Sun 20:00         │
│     "Reminder — papers due Monday"            by Rakesh (WhatsApp) ✓       [⏸] [Edit] [⋯]  │
│  ⟳ Weekly digest              Fri 18:00        agent · proposed   ⚠ waiting for an admin │
│     proposed by Rahul from WhatsApp · 10:44                     [Arm it] [Edit] [Drop]   │
│                                                                                           │
│  ◌ These loops wait while the bridge is paused.                                           │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

*+ New loop* opens the existing `LoopCreateControl` with the subject pre-filled and a flavour toggle; the schedule field accepts the phrases §4.4 accepts and shows the next three firings.

**Permissions.** Creating or arming an agent loop: space admin, human-only (it spends on a schedule; `armed_by_identity_id` (343) is the human who armed it, and 375's act-as rule applies). Message loops: admin in the UI; linked members from WhatsApp within the cap. Pausing a loop: anyone who may create one of that flavour. Guests: none.

### 2.3 What happens to memories and loops when the bridge changes

| Bridge event | Memories | Loops |
|---|---|---|
| **Paused** (`bridges.pause`, incl. *pause for…*) | kept; unused because nothing runs | **suspended**: the executor skips them with `lastError: 'bridge paused'`, `nextRunAt` keeps advancing from now (skip, never backfill). Not disabled — resuming the bridge resumes them with no human step |
| **Degraded** (connection down) | kept | agent loops still run (their result queues in the outbox and is sent when the connection returns, or fails after 6 h with a badge); message loops queue the same way, at most one pending per loop (no pile-up of stale reminders) |
| **Moved** (`bridges.retarget`) | **move with the bridge** — they are on the bridge | **move with the bridge**; the next firing's worker gets the new target's lineage. The §1.5 dialog lists them |
| **Removed** | edges removed; the memories stay in the space | **disabled** (`enabled: false`, `lastError: 'bridge removed'`) and kept, so a human can re-point them; the remove dialog (§1.3) says so |
| **Connection unshared / owner leaves the space** | kept | the bridges pause (standing decision); loops suspend exactly as for *paused*, and the attention request to admins names them |
| **Target ended** (a chat or session ends) | kept | agent loops keep firing (they spawn from the bridge, not the target); the bridge goes `degraded: target ended` until moved |

---

## 3. The WhatsApp commands today — an inventory from code

Read from `origin/main` @ `cfb4622b4` and checked against the deployed copy (`prod-data/wa-bridge/src`, 20 Oct): **the command set is identical**; the deployed copy predates `forms.ts` (forms in groups) and the multi-bridge `handle` setting.

### 3.1 Slash commands (`text.ts parseCommand`, `core.ts runCommand`)

The parser is one regex: `^/(who|status|stop|new|help)(?:\s+@?([a-z0-9][a-z0-9-]{0,40}))?$`, case-insensitive, on the whole trimmed message. Commands are handled only after the sender passes `senderAllowed` and the message is younger than `maxRouteAgeMinutes`.

| Command | Who | What it does | Reply |
|---|---|---|---|
| `/help` | allowed senders | prints how to mention and the command list | 2 lines |
| `/who` | allowed senders | lists live names (handles) in this group: `Title (handle) · @tm8 · kind · teammate`, plus a count of ended ones | list |
| `/status <name>` | allowed senders | one name's state, kind, teammate, tm8 id, who launched it, last route status | 1 line |
| `/stop <name>` | **owner** (by number) | `stopSession` on a session name, marks the name ended and never revives it; refuses main chats ("use /new") | `stopped <name>` or the error |
| `/new` | **owner** (by number) | creates a new main chat (epoch +1), tells the old one to hand over a summary, re-points `@tm8` | `new main chat <name> is up` |

### 3.2 Addressing (how a message reaches an agent)

| Form | Routes to | Notes |
|---|---|---|
| `@tm8 …` (or a real @-mention of the bridge's number) | the group's main chat | `handle` is configurable per bridge (default `tm8`) so two bridges in one group answer only their own |
| `@tm8-<teammate> …` | the main chat, with a note "*the user asked for teammate X → <match>; decide whether to spawn it*" | fuzzy match against the space's teammates; spawning is left to the agent |
| `@<handle> …` (e.g. `@keen-otter`) | that session | unknown handle → main chat with a note; ended → main chat with "*was for keen-otter (ended)*" |
| reply (quote) to a bridge message | the name that sent it | works across a `deliverTo` shadow |
| any message, when the channel's `trigger: 'all'` | the main chat | "listen" mode |

Several targets in one message are de-duplicated per entity; each routed message gets 👀, a failure ❌.

### 3.3 Implicit inputs

| Input | Behaviour |
|---|---|
| media (image, video, document, sticker) | downloaded and logged always; uploaded to tm8 only when routed; referenced (not attached) because of the chat-runtime attachment defect (v1 §7.1) |
| voice notes | transcribed in the background (`transcribe.ts`); the route waits up to `transcription.waitSeconds` and sends a follow-up transcript if late |
| form answers (`forms.ts`, main only) | native poll votes; typed answers `2: answer`, `Q2. answer`, `2) answer`, or a reply to the numbered question; parse errors answered as one-line hints ("*Q2: reply with one option number from 1 to 4*") |
| old messages | older than `maxRouteAgeMinutes`: logged, never routed (stops a reconnect from replaying a day) |

### 3.4 What the bridge says back without being asked

| Signal | Meaning |
|---|---|
| 👀 | routed to an agent |
| ✅ | the first reply to that message was sent |
| ⚠️ | watchdog: no reply after `watchdogMinutes` (text notices were removed as filler, 19 Oct) |
| ❌ | could not reach tm8 after retries |
| `tm8: link not configured yet` | the space token is missing (rate-limited to once a minute) |
| `tm8: the main chat for this group is not ready yet…` | no main chat; one is being created |

### 3.5 Agent-side tools (the HTTP API on `127.0.0.1:8787`, speaker-token auth)

`POST /say` (reply or, with `escalate`, start a thread), `POST /say-media`, `POST /react`, `POST /form`, `GET /forms`, `GET /history`, `GET /search`, `GET /names`, `POST /sync` (look for new sessions now), `GET /message/<wa_id>`, `GET /media/<wa_id>`, `GET /health`, `POST /admin/inject` (operator secret: feed a synthetic message). Briefed into chats by `briefing.ts`, along with RULE 1 (every reply goes through `/say`), RULE 2 (delegate by default: `tm8 task create` + `tm8 session spawn … --launch-project … --workdir worktree`, one mutation id per task, check for an existing session before a retry), the escalation rule and the style line. v1 retires all of this in favour of `tm8 message reply|send` (v1 D8); §4.7 says what replaces RULE 2.

### 3.6 Operator CLI (`admin.ts`, on the host only)

`api-reference`, `set-operator-secret`, `issue-token <name>`, `revoke <name>`, `names`, and nine `rebrief-*` verbs (`media`, `voice`, `trust`, `forms`, `escalation`, `reply`, `delegate`, `style`, `listen`) that print a briefing update for one name. Everything here is either gone in v1 (tokens, briefings) or becomes a UI setting (§1.7).

### 3.7 Why it feels brittle — the weaknesses

| # | Weakness (today) | Where | Fixed by |
|---|---|---|---|
| W1 | **Silent failures.** `/stop` with no name, `/status keen otter`, `/stop keen-otter please`, `/Who?` all fail the regex and fall through to routing — answered only if they also contain `@tm8`, otherwise dropped with no reply | `parseCommand` | §4.2 tolerant parser + "every message gets an answer" |
| W2 | **Not-allowed senders get nothing**, not even "*you can't start agents here — send /link*" | `senderAllowed` before `parseCommand` | §4.6 tiers: `/help`, `/whoami`, `/link` for everyone |
| W3 | **"Owner" is a phone number**, unverifiable ("only as strong as the phone number") and the same everywhere | `isOwner` | links + member roles (v1 §2.4) |
| W4 | **No way to start work by command.** Starting a worker needs a natural-language turn on the main chat, which then spawns by following RULE 2 — slow, costs a turn, and depends on the agent following a briefing | RULE 2 | §4.3 `/work` |
| W5 | **Multiple workers = the agent's discretion.** "do A, B and C" may give one worker or three | RULE 2 | §4.3 one line, one task, one worker |
| W6 | **Capacity is an error.** At the space's 64-session cap the spawn fails and a human has to ask again (it happened on 29 Oct for this very task) | `execution.spawn` | §4.5 launch queue |
| W7 | **Duplicate launches.** Spawns time out yet start; the briefing asks the agent to reuse a mutation id and check connections — a prompt-level fix for a protocol problem | RULE 2 | §4.3 server mutation ids from `wa_msg_id` |
| W8 | **Names appear ~30 s late** (poller), so "*Title (handle) is on it*" waits or is wrong | `pollSeconds`, `/sync` | §4.3: the handle is minted at spawn, in the same transaction |
| W9 | **Managing workers is thin**: no list of what *I* started, no result, no retry, no "stop all", no message to a worker except `@handle` | `runCommand` | §4.4 `/workers`, `/result`, `/retry`, `/tell`, `/stop all` |
| W10 | **Commands only in groups with a main chat**; a DM bridge has no `/work` | — | §4.1 commands are a bridge feature, any target |
| W11 | **Help is one line** and does not list what the sender may do | `/help` | §4.4 `/help [topic]`, per-sender |
| W12 | **No confirmation for wide actions** (`/new` rolls the chat instantly) | `/new` | §4.6 confirm-by-reply |

---

## 4. The command redesign

### 4.1 Where commands run

In v1's inbound pipeline (v1 §2.3), between *resolve the author* (step 2) and *store* (step 3), the server checks for a command. A command is:

- **stored** on the log anchor like any message (the record is the point), marked `command: true`, and **never** routed to the target or shown to an agent as a turn;
- **executed** by `internal.bridge_run_command` with the **linked member's own authority** — the same catalog operations the UI calls (`tasks.create`, `execution.spawn`, `sessions.terminate`, `loops.create`, …), so a command can do exactly what that member could do in the browser and nothing more. A guest has no authority, so a guest can run only the read-only tier (§4.6);
- **idempotent**: every write carries a mutation id derived from `(connectionId, externalMessageId, itemIndex)`. The runtime redelivering the message, a retry after a timeout, or a reconnect replay re-run the same command to the same result (fixes W7);
- **answered** by a bridge notice that replies to (quotes) the command, within 2 s: the final answer, or `⏳` reaction + the answer when it lands. A command that cannot run says why (fixes W1, W2).

Commands are a bridge feature, independent of target kind: a DM bridge to a session or a channel bridge gets them too, each where it makes sense (`/work` on a channel bridge needs worker defaults, §4.3).

### 4.2 Parsing: strict about meaning, tolerant about form

- A command is a message whose **first token** is `/word` (or `!word` — some keyboards autocorrect `/`). Case-insensitive; surrounding whitespace, a trailing `?`/`.`/`!`, and polite tails (`please`, `pls`, `thanks`) are ignored.
- **Aliases** map to one verb: `/workers` = `/w` = `/jobs`; `/stop` = `/cancel`; `/status` = `/s`; `/help` = `/?` = `/commands`.
- **Arguments** accept a handle (`keen-otter`, `@keen-otter`, `keen otter`), a number from the last list the bridge sent *this sender* (`#2`, `2`; valid 30 minutes), a task title prefix (`/stop login fix`), or `all` / `mine`.
- **Unknown or malformed → never routed, always answered:** `"/stp keen-otter" → "tm8: did you mean /stop keen-otter? (/help for the list)"`. A message that merely *contains* a slash mid-sentence is not a command.
- **Multi-line bodies** belong to the command on the first line (`/work` lists, `/remember` paragraphs).
- **Edited messages** do not re-run a command; **deleted** ones do not undo it (it says so if asked).

### 4.3 Many workers from one message: `/work`

```
/work
fix the login timeout on mobile
add retries to the upload client
write release notes for 1.4.3
```

or on one line, items split on `;`: `/work fix login timeout; add upload retries; release notes`

**What the server does, in one transaction per item, keyed by the message's mutation ids:**

1. Creates a **parent task** "*From WhatsApp · Infra · 10:41*" (only when there are ≥ 2 items) with `authored_from → bridge`, and one **child task per line** under it. The task body carries the line, the quoted message if the command was a reply, the sender (as the linked member) and the bridge id. (Rule: a task is created under the task it breaks down — the parent here.)
2. For each child, a **launch request** to the queue (§4.5) with the bridge's **worker defaults**: teammate, project, workdir, access mode, effort (Routing → *Workers*, §1.7). If the bridge has a default project the worker starts in a worktree; otherwise `session dispatch` lets the dispatcher pick.
3. Mints the **handle at request time** (not when a poller notices the session — fixes W8) in `bridge_handles` with `status: 'queued'`, and the 3-4-word title from the task title.
4. Answers once, quoting the command:

```
tm8: 3 workers on it
1 Login timeout fix (keen-otter) — starting
2 Upload client retries (calm-heron) — starting
3 Release notes 1.4.3 (brisk-lynx) — queued, 2 ahead
Reply to a line, or @keen-otter, to talk to that worker. /workers to check.
```

When each actually starts, finishes, blocks or fails, it reports in the thread of *that line* (v1's "replies on bridged messages cross"): `Login timeout fix (keen-otter): done — PR #1421, 2 files.` A worker that blocks posts its question in its thread; the human answers by replying to it. Approvals still never cross (v1 D9): a worker that needs one says "*needs your OK in tm8*" and links nothing secret.

**Options**, inline and optional, per command or per line: `teammate:<name>` (fuzzy, like `@tm8-<teammate>` today), `project:<name>`, `effort:low|high|max`, `x3` (three independent attempts at the same item — a race; each is its own child task, the parent records them as alternatives). Unknown options are answered, not ignored.

**Limits** (Routing → *Workers*): `maxWorkersPerCommand` (default 5), `maxLiveWorkersPerBridge` (default 10). Over a limit, the command is refused whole, with the numbers — never partly started.

**One door for agents too.** The same server path is a catalog operation, `bridges.work.start {bridgeId, items[], options}`, with a CLI verb `tm8 bridge work <bridge-id> --item "<text>"…`. When a person asks in natural language ("*@tm8 can you get someone on A and B*"), the main chat calls this instead of hand-rolling RULE 2. Same queue, same handles, same announcement, same idempotency — whichever way work was asked for, it looks the same in WhatsApp and in tm8.

### 4.4 The full command set

`(L)` = needs a linked member allowed to trigger; `(A)` = needs a space admin linked member; unmarked = anyone in the group, read-only. Every list reply is numbered so `#n` works next.

**Workers**

| Command | Does | Example reply |
|---|---|---|
| `/work <items>` (L) | §4.3 | `3 workers on it …` |
| `/workers` · `/workers all` | live + queued workers started from this bridge (default: mine; `all` = everyone's), with state and age | `1 Login timeout fix (keen-otter) · working 12m · last: "running tests"` |
| `/status <worker>` | one worker: state, task, last update, PR, cost so far | `keen-otter · working 14m · PR #1421 draft · 41k tokens` |
| `/tell <worker> <text>` (L) | message the worker (same as `@keen-otter <text>`, but works for queued workers too: delivered when it starts) | `sent to keen-otter` |
| `/result <worker>` | the worker's close-out message, or its latest report | the close-out, ≤ 10 lines, "*more in tm8*" |
| `/stop <worker>` (L, own workers; A for others') | terminate the session and set its task `blocked` with "*stopped from WhatsApp by Rahul*"; queued → removed from the queue | `stopped keen-otter` |
| `/stop all` · `/stop mine` (L/A) | the same for many, **after a confirm** (§4.6) | `stop 3 workers? reply YES within 2 min` |
| `/retry <worker>` (L) | resume an exited/failed session (`session resume`), else a new launch on the same task | `keen-otter resumed` |
| `/queue` | the launch queue for this space: my position, how many ahead, the cap | `2 ahead of yours · 64 of 64 running` |

**Tasks**

| Command | Does |
|---|---|
| `/task <title>` (L) | create a task without starting a worker (`authored_from → bridge`); returns `#n` |
| `/tasks` · `/tasks open` | tasks made from this bridge, newest first, with status |
| `/start #n` (L) | queue a worker on an existing task (same path as `/work`) |

**Memory and loops** (§2)

| Command | Does |
|---|---|
| `/remember <text>` (L) | propose a memory (accepted in tm8, unless the bridge's switch is on) |
| `/memories` | list the bridge's accepted memories |
| `/forget #n` (L) | propose unlinking one |
| `/remind <when> <text>` (L) | a message loop: `/remind every sunday 8pm papers due monday`, `/remind tomorrow 9am call the bank` (one-off = a loop that disables itself after one firing) |
| `/loop <when> <prompt>` (L) | propose an agent loop: `/loop weekdays 9am post yesterday's merged PRs and today's blockers` |
| `/loops` | list loops on the bridge with next firing |
| `/loop pause|resume|delete #n` (L for own reminders; A otherwise) | as it says; delete asks to confirm |

`<when>` accepts `every <day|weekday|weekdays|day name> [at] <time>`, `daily <time>`, `tomorrow <time>`, `in 2h`, `on 3 nov 10am`, and raw cron in backticks; it is echoed back as a sentence with the next firing ("*every Sunday at 20:00 IST, next 2 Nov*") before it is saved.

**The bridge and me**

| Command | Does |
|---|---|
| `/help` · `/help workers` · `/help loops` | what *this sender* can do here (tiers filtered), ≤ 8 lines per topic |
| `/whoami` | "*you are Rahul (linked ✓) in Infra — you can start workers*", or "*you're a guest here — send /link to link your number*" |
| `/link <code>` | the v1 code link (`TM8-4F7K`); never routed as text, never logged with the code visible |
| `/bridge` | where this group goes, who answers, what crosses back, paused or not — one card |
| `/mute <duration>` (A) | pause the bridge for a while (`/mute 1h`); `/unmute`. A full *pause* stays a UI action, because a paused bridge cannot hear `/resume`: `/mute` is a pause that keeps commands working |
| `/new` (A) | v1 "retarget to a fresh chat", **after a confirm**; the old chat is told to hand over (today's behaviour, kept) |
| `/who` | v1 handles list (today's `/who`, kept as an alias of `/workers all` plus the chats) |

### 4.5 The launch queue — capacity is a wait, not an error

The 64-session cap is a node/space fact; the fix is not to raise it but to stop failing at it.

- `bridges.work.start` (and `/start`, `/retry`) writes a **launch request** row — `launch_requests(id, space_id, task_id, spawn_input jsonb, requested_by, source {bridgeId, externalMessageId, item}, status queued|starting|started|cancelled|failed, position, created_at)` — and returns immediately. The task already exists, so the work is durable even if nothing starts today.
- A scheduler job (the R26 runner, beside `loops.execute-due`) starts requests in FIFO order per space when the cap has room, with the same mutation id each attempt, so a timeout-then-start is one session, not two (W7).
- **Fair share**: at most `maxLiveWorkersPerBridge` per bridge running at once, so one busy group cannot take all 64 slots.
- A request older than 24 h fails with a notice in its thread (*"couldn't start in 24 h — /retry"*); a cancelled task cancels its request.
- The UI gets the same queue for free: a launch from the browser at the cap can offer *Queue it* instead of an error. (This is a space-wide feature the bridge needs first; it should land as its own task, §7 Q4.)

### 4.6 Who may run what

| Tier | Who | Commands |
|---|---|---|
| **Everyone** | any sender, guests included, even when `whoMayTrigger: linked` | `/help`, `/whoami`, `/link`, `/bridge` |
| **Readers** | senders allowed to trigger | `/workers`, `/status`, `/result`, `/queue`, `/tasks`, `/memories`, `/loops`, `/who` |
| **Linked** | linked (or asserted) members allowed to trigger, acting with their own space permissions | `/work`, `/task`, `/start`, `/tell`, `/stop` (own), `/retry`, `/remember`, `/forget`, `/remind`, `/loop` (propose), own-reminder pause/delete |
| **Admin** | linked members who are space admins; **asserted** links never count as admin | `/stop` others', `/stop all`, `/mute`, `/new`, loop pause/delete for any loop |
| **Never from WhatsApp** | — | create/remove a bridge, change trust or `whoMayTrigger`, accept memory proposals, arm agent loops, approvals, anything with a secret |

A bridge admin can switch tiers off (Routing → *Commands*: e.g. a family group with only `/remind` and `/help`). With `whoMayTrigger: anyone`, guests reach the *Readers* tier but never *Linked*: a guest has no member authority to run `/work` as, and the bridge does not lend its own.

**Confirmations.** `/stop all`, `/new`, `/loop delete`, `/work` over 3 items or with `x≥2` answer with a summary and "*reply YES within 2 min*". Only the same sender's reply to that notice confirms; it is stored as a one-use row keyed by the notice's message id. A confirmation is *intent*, not *approval*: it never substitutes for a tm8 approval (v1 D9).

### 4.7 Agents in a bridged chat, after v2

RULE 2 shrinks to one line in the bridge's kind help, not a briefing: "*to start work for the group, use `tm8 bridge work`; to answer, reply to the message*". The main chat remains the front desk for natural language; commands bypass it. The `@tm8-<teammate>` hint becomes the `teammate:` option of `bridges.work.start`, decided by the agent as today.

### 4.8 Robustness checklist

| Concern | Rule |
|---|---|
| Ack latency | ≤ 2 s (reaction `⏳` if the answer needs longer) |
| Duplicate delivery | mutation ids from `(connection, externalMessageId, item)`; the outbox reply is idempotent on the command's message id |
| Rate limits | per-sender 10 commands/min, per-bridge 30/min; over → one notice, then silence for the window (no notice storms) |
| Output size | ≤ 10 lines per reply; `more: /workers 2` paging; never a wall of ids (style line rules) |
| Loop guard | bridge notices carry the v1 echo guard and `BRIDGE_MARK`; a notice is never parsed as a command |
| Time zones | the bridge has a `timezone` (default: the creating member's), shown in every time a command echoes |
| Partial failure | `/work` with 3 items where 1 fails to create: refused whole (one transaction per command for task creation); launch failures are per-item and reported per line |
| Observability | every command is a stored message + a `bridge.command` event with outcome; Health shows *last 20 commands* beside *last 20 outbox rows* |
| Privacy | replies never show phone numbers, token-shaped text or other spaces' data; `/result` quotes the close-out through the credential-shaped-text refusal (Phase-1 relay rule) |
| Tests | a table-driven parser test over every example in this section; one end-to-end per tier through `bridgeRuntime.inbound` with fixture runtime frames |

---

## 5. Contract additions (beyond v1 §3)

| Area | Addition |
|---|---|
| `bridges` content | `pausedUntil: string | null`, `timezone: string`, `commands: { tiers: {readers: bool, linked: bool, admin: bool}, acceptMemoriesFromLinked: bool }`, `workers: { teammateId, projectId, workdir, accessMode, effort, maxPerCommand, maxLive }`, `history: { lastImportAt, lastImportDays }` |
| operations | `bridges.test`, `bridges.history.import`, `bridges.update --dry-run` → `consequences[]`, `bridges.memories.link|unlink|proposals.resolve`, `bridges.work.start`, `launch.requests.list|cancel` (space-wide, §4.5) |
| edges | `remembers` gains `src_kinds += bridge`; loops use the existing `subjectId` |
| loops | `config.bridge {action: 'agent'|'message', text?, quietHours?, onlyIfNew?, replyTo?}`; executor branch for `message`; subject-status pre-check |
| launch defaults | `LaunchDefaultVia += 'bridge'` |
| runtime protocol | `history.fetch {connectionId, conversationId, sinceTs}` → `history.batch {items[], done}` |
| events | `bridge.command {bridgeId, messageId, verb, outcome}`, `launch.request {id, status, position}` |
| tables | `launch_requests` (§4.5), `bridge_command_confirms(notice_message_id pk, sender_external_id, command jsonb, expires_at, used_at)` |
| CLI | `tm8 bridge test|import|work|memory add|remove`, `tm8 bridge update … --dry-run`, `tm8 launch queue [--cancel <id>]` |

---

## 6. Decisions

| # | Decision | Alternatives | Why |
|---|---|---|---|
| V1 | Memories and loops attach to the **bridge** | attach to the target chat | the group's knowledge and schedule belong to the group; retargeting must not lose them; one memory can serve several bridges |
| V2 | Bridge memories reach agents through `launch.defaults` (`via 'bridge'`) and the chat turn's working set | a briefing message on the chat | one measured, visible, budgeted path; no prompt text in messages |
| V3 | `/remember` and agent `/loop` from WhatsApp are **proposals**; message reminders are direct, capped | all direct for linked members | a memory or an agent loop is a persistent prompt and a recurring spend; a phone number is a weak identity (v1 D9) |
| V4 | Commands execute server-side as the linked member, through catalog operations | commands as prompts to the main chat (today's RULE 2) | deterministic, instant, cheap, auditable, same permissions as the UI |
| V5 | `/work`: one parent task, one child per line, one launch request each, handles minted at request time | one task with several sessions; agent decides | a line is a unit of work people can address and stop; durable before capacity exists |
| V6 | Every message gets an answer; unknown commands are never routed | today's silent fall-through | the top source of "the bridge is broken" |
| V7 | A space-wide **launch queue**, fair-shared per bridge | raise the cap; fail and ask the human | the cap protects the node; a queue turns a refusal into a wait |
| V8 | Pause from WhatsApp is `/mute` (commands keep working); full pause is UI-only | `/pause` + `/resume` | a fully paused bridge cannot hear `/resume` |
| V9 | Every widening change goes through one consequence dialog fed by a server dry run | per-setting ad hoc warnings | words computed from data, the same in UI and CLI |
| V10 | Mobile linking uses the pairing code; QR moves to a second screen by a member-addressed hand-off | QR only | a phone cannot scan its own screen |

---

## 7. Open questions (with recommendations)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Should `/work` from a **linked member who is not a space admin** be allowed by default? | Yes, within the per-bridge limits — it is what the main chat already does for them today; admins can turn the *Linked* tier off per bridge. |
| Q2 | Should the owner be able to accept a memory proposal **from WhatsApp** (e.g. replying YES)? | No for now (V3). Revisit when a link can be step-up verified (a fresh code) — then a code-verified admin could accept with `/accept #n TM8-XXXX`. |
| Q3 | Cost visibility: should `/status` show tokens or money? | Tokens and a running count per bridge this week; money only where the space has a price table. Needs the tracking owner's view. |
| Q4 | The launch queue is space-wide: who owns it? | A separate task in the execution lane, landing before bridge B2's `/work`; bridges are its first client, the launch sheet its second. |
| Q5 | `x3` races: should tm8 pick a winner? | No — report all three; the human picks by replying `/keep #2`. Out of scope for the first cut; ship `/work` without `x<n>` first. |
| Q6 | Message loops in a **guest-heavy group**: may a guest-triggered `/remind` exist? | No; reminders need a linked member, so someone in tm8 is accountable for what the bridge posts on a schedule. |
| Q7 | Default timezone when a member links from abroad? | The creating member's profile timezone, editable on Routing; every echoed time names its zone. |
| Q8 | Phase-1 interim: port `/work`, `/workers`, the tolerant parser and "always answer" into `core.ts` now, before v1's runtime refactor? | Yes, the parser and "always answer" (W1, W2, W11) are cheap and independent; `/work` should wait for `bridges.work.start` so the logic is written once, on the server. |

---

## 8. Build order (slots into v1 §7.2)

| Phase | Adds from v2 |
|---|---|
| **P0 (now, Phase-1 code)** | tolerant parser, never-silent replies, `/whoami`, richer `/help` (Q8) |
| **B0** | contract additions §5; `launch_requests` + queue job (own task, Q4) |
| **B1** | server-side command executor; `/work`, `/workers`, `/status`, `/tell`, `/stop`, `/result`, `/retry`, `/queue`; `bridges.work.start` + CLI |
| **B2** | UI gaps §1.1–1.6; Memory and Loops tabs; consequence dialog |
| **B3** | memories (`remembers` from bridge, `via 'bridge'`, proposals); loops (`message` action, subject pre-check, `/remind`, `/loop` proposals); `/remember`, `/forget` |
| **B4+** | history import per provider as each driver lands |

**Acceptance for the command layer (B1):** a `/work` with three lines from a linked member creates one parent and three child tasks, three handles, and one reply within 2 s; redelivering the same WhatsApp message creates nothing new; at the session cap the third item reads *queued* and starts by itself when a slot frees; `/stop calm-heron` from another non-admin member is refused with a reason; `/stp` gets a did-you-mean; a guest's `/work` gets "*link your number first*"; no command text ever reaches the main chat as a turn.
