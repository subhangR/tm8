# Loops — user guide

A **loop** is recurring scheduled work that tm8 keeps for you. It has a *when* (a schedule in a timezone), a *who* (a teammate, the Dispatcher, or a tool) and a *what* (the instructions each firing carries). Every firing is recorded as a **run**, so you can always see whether a loop is healthy, what it last did, and open the session that did it.

The server owns the clock. No form, command or agent ever sends a next-run time: the server computes it on create, on enable and whenever the schedule or its timezone changes. What you see in a preview is what will happen. The design of record is [DESIGN.md](DESIGN.md), the command reference is [docs/api-and-cli/LOOP-CLI.md](../../api-and-cli/LOOP-CLI.md), and [VERIFY.md](VERIFY.md) shows how to check it all locally.

## The schedule

- `every <n>m`, `every <n>h` or `every <n>d`: an interval. Intervals are zone-free.
- A five-field cron line, `minute hour day-of-month month day-of-week` (for example `0 9 * * 1-5` for weekdays at 09:00). It is read on the wall clock of the loop's **timezone**, an IANA name such as `Europe/London`. The default is UTC in the CLI, and in the UI the browser's zone. Across a DST change, a minute that does not exist is skipped, and one that happens twice fires once.

Preview any schedule before you write it:

```bash
tm8 loop preview --schedule '0 9 * * 1-5' --timezone Europe/London --count 3
```

The server answers with a summary in words and the next instants, or with the problem, in which case the command exits 2. A schedule that can never match (the 30th of February) is stored but **parked**, with that reason as the loop's last error. It is never silently "never due".

## What a firing does

| Action | Each firing… | You choose |
|---|---|---|
| **Teammate** (`spawn`) | spawns that teammate's session on a task derived from what the loop is about (or the loop itself). An open derived task is reused, so firings gather on one task until someone closes it. | the teammate, plus optional launch settings (model, effort, access, mode, project, working copy, memories, credential source, interaction profile) |
| **Dispatcher decides** (`dispatch`) | sends a dispatch request; the Dispatcher picks who does it. | nothing more |
| **Tool** (`tool`) | runs the tool with the inputs you typed. A tool that reaches tm8 runs as the teammate under *Runs as*. A secret input uses the secret bound on the tool, since a loop never stores one. | the tool, its inputs, and *Runs as* |

A firing acts as the loop's **armer**: the human who last created, enabled or edited it. If that person has left the space, it acts as a fallback member, and the loop page names who. An agent's edit disarms a loop, and a loop with no one to run as is parked as *needs arming* until a human enables or edits it.

**If the previous run is still going**, a loop set to *skip* (the default) records the firing as a skipped run, and one set to *queue* waits and fires as soon as the previous run settles. Missed firings are **never backfilled**. A node that was down for six hours fires a due loop once when it is back, and the next deadline is counted from that firing. A **pause** holds firings until an instant; a deadline that fell inside it fires once when the pause ends. A launch that fails is recorded on the run and as the loop's last error, and with **retries** set it is tried again after the retry delay. A run that outlives its **max runtime** is stopped and recorded as timed out. Failures never disable a loop.

> Until loops PR3 (#1408) merges, a tool loop is accepted but refused at every firing, with a last error that says so, and a teammate loop carries only its model, agent tool and access mode.

## Create a loop

### In the UI

Start **New loop** from the New tab (or press `n` then `l`), from ⌘K "New…", or from the loops list header. The form asks:

1. **Name**.
2. **What should run?** Choose *Teammate*, *Dispatcher decides* or *Tool*, then the picker for each: the teammate, or the tool with its own inputs and *Runs as*. You never type an id.
3. **About** (optional): what the loop is for. A teammate's task is derived from it.
4. **Instructions**: what each firing should do. In the edit dialog you can reference skills with `/` and attach files.
5. **When**: a preset (Hourly, Daily at…, Weekdays at…, Weekly on…, Every N minutes or hours) or a custom cron, plus the timezone. The **preview** beside it is the server's summary and next five runs, in the loop's timezone. You can't create an invalid schedule.
6. **Advanced** (collapsed): the launch settings, *If the previous run is still going* (skip or queue), max runtime, retries and the retry delay.
7. **Enable now** (create only).

A server refusal lands on the field it names. In a Workspace draft tab, the form keeps what you typed across tab switches and reloads.

### From the CLI

```bash
tm8 loop create 'Morning triage' --schedule '0 9 * * 1-5' --timezone Europe/London \
  --teammate Ada --prompt @triage.md --when-to-use 'Open when the morning triage misfires'
tm8 loop create 'Inbox routing' --schedule 'every 2h' --dispatch --prompt 'Route anything unassigned'
tm8 loop create 'Nightly backup' --schedule '17 3 * * *' --tool backup --input target=s3 --teammate Ops
```

`--teammate` and `--tool` take a name or an id. Every flag is in [LOOP-CLI.md](../../api-and-cli/LOOP-CLI.md).

### From an agent (MCP)

An agent on a space's MCP server finds every `loops.*` operation in two directories. `tm8_read` holds `loops.list`, `loops.get`, `loops.runs.list`, `loops.runs.get` and `loops.schedule.preview`. `tm8_act` holds create, update, enable, disable, pause, resume, runNow and runs.stop. Each command carries a `clientMutationId`, so a retried call is replayed, never applied twice. A coordinator's prompt carries one line on it: recurring work is a loop, not a worker kept waiting.

## Inspect it

The **loop page** shows:
- a status pill (Enabled, Paused until …, Disabled, Waiting on previous run), the next run in the loop's own timezone, and the last error;
- who armed it and who it runs as, and a runs summary (fired, failed and skipped in the last 24 h);
- WHAT IT RUNS, SCHEDULE (the summary and next runs) and SETTINGS;
- **RUNS**: one row per firing, with when it fired, the trigger (Schedule or Run now), the status (running, completed, failed, skipped, stopped, timed out), its duration, the task and session links, and the error or skip reason. *Open session* opens the session's own tab, and a running row has *Stop*.

The loops list (desktop) has a row per loop: Title, Runs (teammate, Dispatcher or tool), Schedule, Next run, Last run and an Enabled switch. The Work browser and the phone show each loop's schedule and next run as the row's second line.

From the CLI: `tm8 loop show <id|title>`, `tm8 loop runs <id> [--status failed]`, `tm8 loop run-show <run-id>`, and `tm8 session transcript <session-id>` for what a firing did.

## Control it

- **Run now** fires the loop at once, beside its schedule (the next run is untouched), and answers with the run and its session. While a run is live it refuses (`loop_run_overlap`) unless you choose *Run anyway* (`--force`). It also fires a disabled loop, once, and the schedule stays off.
- **Pause…** takes an hour, tomorrow at 09:00 or a time you pick. **Resume** ends a pause early.
- **Enable** counts the next run from now. **Disable** keeps everything and fires nothing.
- **Edit** opens the same form. Only what you change is sent, under the loop's version.
- **Stop** (on a running run) stops its session, and the run settles as stopped.
- **Delete** removes the loop; the tasks and sessions it made remain.

**Every firing also moves a loop's version.** So a CLI `--expect-version` refused with `version_conflict` on a busy loop usually means it just fired: `tm8 loop show` gives the new version. The UI does this for you. An edit is re-read and resent when nothing you changed moved, and asks you to re-read only when someone else changed the same thing.

## A session at the terminal

This is real output from this build, produced by the e2e suite (VERIFY.md) against a real node with real PTYs: preview, create, enable, Run now, an overlap, runs, stop, pause, resume, an edit, a stale edit, disable, show and list.

TRANSCRIPT_PLACEHOLDER

## When something looks wrong

| You see | It means |
|---|---|
| Last error, and the loop still enabled | A launch failed or a run failed; failures never disable. Fix the cause; the next firing tries again, and retries if set. |
| Parked: *schedule never matches within a year* | The schedule can't fire (for example the 30th of February). Edit the schedule. |
| Parked: *needs arming* | No one it can run as: the armer left, or an agent edited it. A human enabling or editing it arms it. |
| `version_conflict` from the CLI | The loop moved since you read it, often because it fired. Run `tm8 loop show` and retry with the new version. |
| `loop_run_overlap` from Run now | A run is still live. Wait, stop it, or `--force`. |
| A tool loop's last error says tool loops cannot run yet | The tool action ships with loops PR3 (#1408). |
