# Terminal perf-parity rig — operating procedure

**Owner:** Lynx (Quality). **Gate:** G3 (terminal perf parity with old maestro).
**Normative source:** AM-1 / T-D21 — *"parity is achievable but must be
**measured explicitly, never assumed**"* (STATE.md, AM-1 note (a)).

This document is the operating manual for `pty-latency.mjs`. Its centrepiece is
§4, the **controlled baseline run** — the one measurement that writes into a
live PTY and therefore has to be scheduled, not improvised.

---

## 1. What the rig measures, and what a number here means

Four modes. Three are read-only and can be run against the live legacy server at
any time; one is invasive and is gated behind two independent opt-ins.

| Mode | Writes? | Measures |
|---|---|---|
| `attach` | no | connect → open → handshake → hydration; replay throughput |
| `observe` | no | live-frame cadence, bytes/s, 16ms-coalescing conformance |
| `fanout` | no | per-subscriber delivery skew across K concurrent viewers |
| `echo` | **YES** | keystroke → first-byte-back round trip (true end-to-end latency) |

**The parity claim is a *difference*, not an absolute.** Every number the rig
reports includes the rig's own overhead: a Node WebSocket client, the event
loop, and `performance.now()` sampling. The self-test measures that floor
directly — against a fixture that echoes in 1ms, the rig reports ~10–12ms p50 on
this machine. So a raw "18ms" from `--mode echo` is not "the terminal takes
18ms"; it is "the terminal takes 18ms *as this rig measures it*".

That is fine, and it is the reason the rig is target-agnostic: the overhead is
common-mode across `--target legacy` and `--target tm8`, so the **comparison**
survives even though neither absolute does. Never quote a single number from
this rig as a user-facing latency. Quote the pair, measured on the same machine.

**Same machine, or it is not parity.** Every artifact records
`machine.hostname`, CPU model, arch, and 1-minute load average. Before comparing
two artifacts, check those match and that load was comparable. A tm8 number from
a quiet machine against a legacy number taken mid-build is not evidence.

---

## 2. Before anything: run the dry run

```sh
cd tools/rigs/perf
node echo-dry-run.mjs
```

Seven offline checks, no server involved. They exist because the echo mode gets
exactly one shot at a scheduled session, and its failure modes are quiet ones —
a rig that measured the scrollback replay blob instead of the echo, or that
reported a plausible number when nothing came back, produces a baseline that is
*wrong* rather than absent. A wrong baseline is worse than none: G3 is judged
against it, so a fabricated number silently moves the bar.

The dry run stands up a mock of old maestro's `/pty` protocol with a **known**
injected delay and runs the real `modeEcho` against it, checking:

1. the mock's own RFC 6455 handshake against the spec's worked example
   *(this caught a one-character GUID typo that otherwise surfaced only as an
   opaque `websocket error`)*;
2. the **safety interlock** — echo mode refuses to run without
   `TM8_PERF_ALLOW_WRITE=1`;
3. **ground truth** — a 25ms fixture reads back as ~25ms, not as something else;
4. **replay is not an echo** — no sample has the byte size of the scrollback
   blob (the subtle bug: a replay frame measured as a keystroke response);
5. **discrimination** — a 1ms fixture reads faster than a 25ms one, proving the
   number is a measurement and not a constant floor of rig overhead;
6. **loud failure** — a PTY that accepts input and never echoes yields
   *timeouts and no number*, never a fabricated one (this is R17's
   silent-failure mode expressed in perf terms);
7. the legacy adapter parses the `attached` handshake frame.

All seven must pass. Artifacts land in `dry-runs/`.

---

## 3. Read-only baselines (no scheduling needed)

The legacy server for baselining is **`:4570`** (authMode none, commit `07d504d`,
already running `MAESTRO_PTY_HOST=server`). Staging `4569/4568` and prod `3001`
also exist — **do not point any rig at them**.

```sh
node pty-latency.mjs --target legacy --mode attach  --cycles 12
node pty-latency.mjs --target legacy --mode observe --seconds 60 --session <id>
node pty-latency.mjs --target legacy --mode fanout  --subscribers 4 --seconds 45
```

These attach and watch; they never send. Running them against a working agent's
session is safe. Committed legacy baselines live in `baselines/`.

---

## 4. Controlled baseline run — the keystroke-echo measurement

> **This mode writes into a live PTY.** It sends a bare CR (`\r`) — the most
> inert thing a shell or TUI echoes, never a command — but a CR delivered into a
> working agent's prompt still submits whatever that agent had typed. There is
> no undo.

### 4.1 Vega schedules a session for this

The measured session must be **spawned for the measurement**: a plain shell,
sitting idle at a prompt, owned by nobody. Do not borrow a session that happens
to look quiet.

This distinction is not cosmetic. During development the preflight **passed**
against a session whose status was `working` — a live agent that was thinking
rather than printing, so the idle watch saw zero frames. Quiet is necessary and
not sufficient, which is why the preflight now has a separate status gate (§4.2).

### 4.2 Preflight the designated session (read-only)

```sh
node echo-dry-run.mjs --preflight --session <id> [--quiet-seconds 20]
```

Sends nothing on the socket. It checks that:

- the target answers and the session id is in the live list;
- the session is **not** a working agent (`status: working` is refused unless the
  operator asserts otherwise with `--confirm-controlled`);
- attach + handshake succeed;
- the stream is **quiet** for the watch window — zero unsolicited frames. The
  echo metric attributes *the next binary frame* to our keystroke; on a session
  producing output on its own that attribution is simply false, and the number
  would be fiction.

Exit code is non-zero if any check fails, and the baseline command is printed
**only** when all of them pass. A failed preflight means re-designate the
session; it does not mean override the check.

### 4.3 Run the baseline

```sh
TM8_PERF_ALLOW_WRITE=1 node pty-latency.mjs \
  --target legacy --mode echo --controlled-session <id> \
  --cycles 20 --label controlled-baseline
```

Both opt-ins are mandatory and independent: the env var, and
`--controlled-session` (echo mode refuses `--session`, so a session id cannot
drift in from another command line by habit).

The rig settles 1500ms after the handshake — so the scrollback replay lands
before sampling starts — then sends one CR per cycle with 400ms between samples,
well clear of the server's 16ms coalescing window.

### 4.4 Check the artifact before believing it

Artifacts go to `baselines/<target>-echo-<timestamp>.json`. Before quoting a
number:

- `result.timeouts` is 0 (any timeout means some samples measured nothing);
- `result.roundTripMs.n` equals `--cycles`;
- `result.samples[*].bytes` are all small and consistent — a sample carrying
  kilobytes measured scrollback, not an echo;
- `machine.loadAvg1m` was low — a loaded machine inflates every number;
- p50 is meaningfully above the ~10–12ms rig floor from §1. If it is at the
  floor, the rig is reporting itself.

Raw per-sample values are kept in every artifact precisely so any statistic can
be recomputed independently. Polaris audits the artifact, not the claim.

### 4.5 Release the session

Tell Vega the run is complete so the measurement session can be torn down. A
session spawned for measurement and left running is a session someone will later
mistake for a real one.

---

## 5. When tm8 lands (M3+)

The same commands with `--target tm8` produce the comparison half:

```sh
node pty-latency.mjs --target tm8 --mode attach --base-url http://localhost:4610
TM8_PERF_ALLOW_WRITE=1 node pty-latency.mjs --target tm8 --mode echo \
  --controlled-session <workSessionId> --cycles 20
```

`adapters.mjs` handles the difference: tm8 reaching a stream is a two-step dance
(`execution.streams.attach` → grant → connect) rather than legacy's single URL,
and `prepare()` absorbs that so no measurement code changes. Two things stay
genuinely unknown until Orion lands the M3 stream plumbing, and are marked in
`adapters.mjs` rather than guessed: the resume cursor (legacy uses a raw byte
`?offset=`), and the control-frame vocabulary. Until they are fixed, an
unrecognised handshake surfaces as a loud timeout — never a silent zero.

The dry run's mock speaks the *legacy* protocol. When the tm8 stream vocabulary
is settled, add a tm8 fixture to `echo-dry-run.mjs` and re-run §2 before the
tm8-side controlled run. Do not skip it on the grounds that the rig "already
works" — it will have been proven against a different protocol.

---

## 6. Files

| Path | What it is |
|---|---|
| `pty-latency.mjs` | The rig. Four modes; `modeEcho` is exported for the dry run |
| `adapters.mjs` | Per-target seams (`legacy`, `tm8`); the only system-specific code |
| `echo-dry-run.mjs` | Self-test + read-only preflight; gates §4 |
| `../lib/ws.mjs` | Frame recorder (client side) |
| `../lib/ws-server.mjs` | Minimal RFC 6455 **server** — test fixture only, zero-dep |
| `../lib/stats.mjs` | Percentiles, histograms, rounding |
| `baselines/` | Committed measurement artifacts |
| `dry-runs/` | Dry-run/preflight artifacts (evidence, not baselines) |

`tools/rigs/` is deliberately **zero-dependency** (Node ≥22 global `fetch` /
`WebSocket`) so these rigs never churn `bun.lock`. That constraint is why
`ws-server.mjs` implements framing by hand rather than pulling in `ws`.
