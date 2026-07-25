# Terminal transplant — what the streaming owner knows that the code does not say

**Source:** maestro perf/corruption session `sess_1784921923533_ad4ub81gu`, answering Atlas, 2026-07-25.
**Status:** binding for Lane D. Everything here is a lesson maestro paid for; none of it is inferable from reading tm8's tree.

---

## 0. Why this file exists

`real/terminal/ptyTransport.ts` opens by claiming its wire protocol is *"byte-identical to maestro's"*. It is not, and acting on that sentence is how this transplant nearly shipped four gaps. The protocol CORE is faithful — offset resume, the `attached{base,gap,next,hasReplay,epoch}` ack, the single display-only replay frame, epoch/gap reset rules, the per-session streaming decoder, suspend/resume. What is missing is everything the comment implies is present.

Two corrections to briefs Atlas issued from that sentence, recorded because being wrong in writing is cheaper than being wrong in someone's memory:

1. **There is no visibility EVENT.** Atlas briefed `visibility:hidden` as "the signal the driver suspends on". Neither `visibility:hidden` nor `display:none` fires anything. The driver **polls** `getComputedStyle(el).visibility === 'hidden'`, reconciled every 2s, with an explicit reconcile kick on active-terminal switch (double-rAF after the switch commits). `HIDE_GRACE_MS` 10s before suspend; resume-on-show immediate; `WARM_LRU_SIZE` 3 most-recent stay live. `visibility:hidden` is still the right choice — because it keeps layout non-zero so `fit()` stays truthful, not because it fires. Computed style walked UP the tree is the only honest signal, because terminals are reparented imperatively and React props lie.

2. **tm8's single-mount IS `mount-only-active`** — the pattern maestro shipped and then deliberately reverted. See §2.

---

## 1. WebGL — settled, and the reasoning is not what the brief said

Commit `3d357dd` added the WebGL renderer with a DOM fallback. **The working tree has since removed it** (`SessionTerminal.tsx:222-230`, "intentionally DOM renderer only"). `@xterm/addon-webgl` sits in maestro's `package.json` unused repo-wide.

The revert was **purely the multi-terminal GPU-context cap** — one terminal on WebGL worked fine on web. At the time this was written tm8 mounted a single terminal, which made DOM-only *caution rather than necessity*; under the bounded mounted-LRU stamped in §2 (k mounted xterms, not one) the cap becomes a live concern again, so DOM-only is now the load-bearing choice rather than the cautious one. The DOM renderer is ~free at these mount counts either way. Revisit only if profiling shows the renderer hot; if it is ever revisited, context-loss fallback is mandatory (backgrounded tabs lose GPU contexts) and the addon hard-crashes under Tauri/StrictMode (not tm8's problem — web only).

---

## 2. MOUNT POLICY — the owner's verdict: neither pure option

Asked directly which he would defend six months out for tm8's shape (one centre pane, session list beside it, DOM renderer), the streaming owner answered **neither** — take the union, "because both of its mechanisms are things you are FORCED to build anyway":

| | |
|---|---|
| **bounded MOUNTED-LRU** | k mounted xterms, evict least-recently-viewed with **full dispose** |
| **socket suspend** | for the mounted-but-hidden ones; CPU becomes O(visible) |
| **warm sockets** | top 3 |
| **full-ring replay** | offset=0, when an **evicted** session returns |

**These are TWO SEPARATE DIALS and conflating them re-ships a failure maestro already had.** `WARM_LRU_SIZE=3` bounds *warm sockets*, not *mount count*. Reading it as the mount bound gives "mount everything, keep 3 sockets warm" — which is exactly the RAM-growth failure below, wearing the name of the fix.

Why not either pure option:

- **Pure keep-all-mounted fails on MEMORY.** Each xterm holds its scrollback buffer + DOM forever, so renderer RAM grows with fleet size. maestro *shipped this*: exited agents kept 5000-line buffers mounted, RAM grew with every run, and unmounting had to be bolted on afterwards.
- **Pure single-mount fails on UX and on DISPOSE FRAGILITY.** Every switch costs a blank-then-replay flash and a full parse of up to 1 MiB of ring — in an orchestrator UI where flipping between agents is *the* core gesture. And dispose-from-every-module-map is an invariant any future contributor can silently break; that is where their leak came from. In his words: *"it is not that single-mount can't be correct; it is that its correctness is distributed across the whole codebase."*
- **The union is not extra complexity.** Suspend is required for CPU regardless of mount policy; full-replay-remount is required for eviction, reconnect-after-gap and epoch change regardless. Both paths then get exercised constantly instead of rotting as edge cases.

For tm8 today: **start k=4; the constant is a dial.** What matters is that the architecture *has* the dial, so scaling to 30 agents is a config change rather than a rewrite.

> Nothing built for single-mount is wasted: reset-offset-to-0 + full-ring replay and airtight dispose are required under the LRU design too. They move from *every switch* to *every eviction return*.

---

## 2a. If single-mount is kept anyway — two mandatory consequences

**Not the model tm8 is building — §2 is.** Kept because both obligations below survive under the LRU design, and because the reasoning is what makes §2 make sense.

Mounting exactly one terminal, keyed by `sessionId` and torn down on switch, IS `mount-only-active`. maestro shipped it and reverted it because a fresh xterm per switch **leaked** old instances still referenced in module-level maps, and it flashed blank-then-replay on every switch.

Anyone keeping single-mount **must** do both of these — and note they are required under the bounded-LRU model too, where they simply fire on *eviction return* rather than on *every switch*:

- **Reset the resume offset to 0 and take a FULL-RING replay on every switch.** A fresh xterm resumed at a *preserved* offset renders a near-blank delta — the silent-hole bug. tm8 remounts per session id today, so it hits this the moment a user switches between two sessions.
- **Airtight dispose.** Delete the session id from *every* module-level map on unmount: registry, write-scheduler buffers, decoders, offsets, epochs, suspended, pendingReplay. That is precisely where maestro's leak lived.

---

## 3. The four drift items, with the parts that are not obvious

**Bounded fail-closed pending-send queue + overflow latch.** tm8 currently *drops input while disconnected* — keystrokes vanish silently. On overflow, discard the **entire queue including the triggering frame**, then **latch**: every later frame drops until a socket successfully **OPENS**. Open is the only thing that clears the latch, and it survives failed reconnect attempts. **Drop-oldest is actively dangerous** — it keeps the *tail* of a chunked paste and executes a partial shell command on reconnect. No oversized-frame exception. Warn once per episode.

**Wake + online reconnect staggering.** Exactly one session reconnects immediately; the rest take deterministic 250ms slots capped at 2s, plus jitter. The subtle part is **idempotency**: a second wake must neither duplicate timers nor re-slot an already-staggered session. maestro keeps a `_wakeStaggered` set, and backoff and stagger share **one timer slot per session** so duplicates are structurally impossible.

**`requestFullReplay` remount path.** **Delete the socket from the map BEFORE closing it** — otherwise the `onclose` identity guard tears down fresh state, and on A→B→A churn `_ensureSocket` hands back a still-`CONNECTING` stale socket. Clear decoders / pendingReplay / epoch / suspended and zero `_received` in the same breath.

**`size.live` metadata** (landed the same day — take the current tree). Server broadcasts `{type:'size',cols,rows,live:true}` to all subscribers **except the origin socket**, and **skips unchanged sizes** — that unchanged-skip is what terminates client echo loops. Client side is three-legged:
1. live frames bypass the after-first-fit latch, so passive views follow;
2. **computed-hidden views never fit and never ship a resize** — a hidden mount silently stomps the shared PTY and garbles every visible view (a background tab was caught resizing a live PTY to 38×80 merely by mounting);
3. the activation effect reclaims by comparing against **PTY truth** (`serverPtySizes`), not its own last-shipped dedupe.

Miss leg 2 or 3 and multi-viewer garbling returns.

---

## 4. The invariant nobody listed — and exactly how to close it

**The client offset advances on frame ARRIVAL, but writes are rAF-coalesced.** So before suspending you must **synchronously flush the write scheduler into xterm** — otherwise buffered bytes are counted-as-consumed but never rendered. Silent hole, and no gap marker to reveal it.

Flushing into xterm is sufficient, but only under three conditions, and the third is the one people miss:

1. The flush is **synchronous and unconditional** — a direct `term.write` bypassing the hidden-terminal throttle (`force=true`), *not* a scheduled rAF.
2. If the terminal is unmounted or not-ready, the flush must **drain into a durable pre-mount pending buffer, never discard**. "Flushed" means *these bytes will provably reach a terminal*, not *I called write*.
3. **Flush and suspend must run in ONE synchronous block** — no `await`, no microtask gap. The hole is not the flush; it is a frame **arriving between** flush and close: it advances the offset, lands in the scheduler buffer, then the socket closes with those bytes counted-but-unrendered. Same-task sequencing makes that impossible because `WS.onmessage` is a separate macrotask. If the driver must be async for other reasons, **re-flush as the last synchronous act before close**.

**Do NOT hold the offset back until render.** The offset's contract is "bytes that will provably be rendered", in **raw-arrival space** — which is what `attached.next` snaps against. Advance-on-render sounds cleaner and is worse: reconnects race the scheduler mid-batch and you inherit a partial-batch offset with no server-side meaning.

Also, all load-bearing:

- Snap `_received` to `attached.next` — **never** `base + data.length`. Never count the replay frame.
- Keep **one** streaming `TextDecoder` per session across clean reconnects; UTF-8 glyphs straddle frames.
- **Order is protocol**: `attached` ack → the single replay frame → live bytes. A refactor that sends replay first wipes it on reset.
- After `{type:'exit'}` the server **closes all subscriber sockets** — record the exit *before* the close arrives, or the close reads as a transport drop and you reconnect into a dead session.
- Epoch: compare by **equality only**, never ordering. Reset xterm only on epoch change, `gap > 0`, or legacy base rewind.
- Replay hydration: keep the xterm element hidden until the last replay byte is parsed, reveal on rAF — otherwise thousands of cursor redraws visibly scroll past.
- **Never `fit()` before the terminal webfont has loaded** — fallback metrics compute the wrong cols and poison both the PTY and the ring at the wrong width.
- Skip `fit()` entirely while a splitter is mid-drag; reflow once on drag-end. (tm8's workspace has two resizers.)
- The `/pty` text-frame contract lives in the shared `@maestro/pty-protocol` package. Re-export is a same-repo trick and tm8 is a different repo, so **the fork exists by construction — make it an HONEST one** (see §6).
- Transplanting `useMaestroStore` verbatim inherits an unbounded-timeline heap leak: the server re-broadcasts the full session (ever-growing `timeline[]`) ~2×/sec. maestro caps timeline/events to the last 300 at ingest.

---

## 5. Vendoring the protocol package — and making the fork honest

`@maestro/pty-protocol` carries the `/pty` text-frame contract. Re-export is a same-repo trick; tm8 is a different repo, so **the fork exists by construction**. Therefore:

- **Vendor it outright**, from *today's* tree — that is what gets the current wire contract including `size.live` (`live?: boolean`, explicit `true` only).
- Copy the **`parseControlFrame` test suite verbatim**. Those tests *are* the contract: unknown fields ignored, non-finite size rejected, `epoch` must be a string, `replayKind` whitelist, non-JSON and unknown-type → `null` → verbatim passthrough.
- **Extract the vectors into a `golden-frames` JSON fixture** — `[{input, expected}]` — that **both repos carry**. Drift then becomes a plain file diff needing no tooling, and any contract change forces a visible golden edit on whichever side moved.
- **One rule: never "improve" the parser in the fork without a golden change.** The parser is boring on purpose.

This is the thing that stops the port rotting six months out, so the fixture is a **committed test**, not a convention.

---

## 6. node-pty

- Beyond the bun exec-bit strip (`scripts/repair-node-pty.sh`, then `packages/execution` harness 5/5): **`onData` simply never fires under bun.** Run the PTY host under node, period.
- If tm8 takes maestro's 16ms PTY output coalescing, it **must flush the coalesce buffer before every attach / replay / snapshot / exit boundary**, or byte offsets desync from the ring.
- Server Jest needs `--forceExit`; PTY handles keep the process alive.

---

## 7. tm8 clipboard-image capability gap

Text paste is fully backed and stays live. Image paste is the one Maestro
terminal affordance with no tm8 server operation behind it today, so the UI must
keep it visible/captioned but disabled with the reason that `files.upload` is not
implemented on this node. Enabling it requires `files.uploadInit`,
`files.uploadComplete`, and `files.uploadAbort` plus a real server-side blob
directory.

This can never be a client-only feature: Maestro uploads the image and injects
an absolute **server path** into the PTY prompt. The file must genuinely exist on
the same server where the agent is running; a `data:` URI, browser blob URL, or
invented local path would corrupt the running agent's input rather than complete
the paste.
