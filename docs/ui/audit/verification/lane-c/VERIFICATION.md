# Lane C verification — centre terminal + app chrome

Verified 2026-07-25 at 1600×1000, device scale factor 2, against an isolated
echo-agent stack. The user's live server on `:4620` was not used by this drive.

## Files verified

- `bun.lock`
- `packages/ui/package.json`
- `packages/ui/src/real/SessionTerminal.tsx`
- `packages/ui/src/real/terminal/clipboardImages.ts`
- `packages/ui/src/real/terminal/clipboardPaste.ts`
- `packages/ui/src/real/terminal/domUtils.ts`
- `packages/ui/src/real/terminal/notifications.ts`
- `packages/ui/src/real/terminal/ptyProtocol.ts`
- `packages/ui/src/real/terminal/ptyTransport.ts`
- `packages/ui/src/real/terminal/ptyTransport.test.ts`
- `packages/ui/src/real/terminal/runtime.ts`
- `packages/ui/src/real/terminal/terminalSize.ts`
- `packages/ui/src/real/terminal/useTerminalSettingsStore.ts`
- `packages/ui/src/real/terminal/visibilityDriver.ts`
- `packages/ui/src/real/terminal/visibilityDriver.test.ts`
- `packages/ui/src/real/workspace/CenterPane.tsx`
- `packages/ui/src/real/workspace/Composer.tsx`
- `packages/ui/src/real/workspace/IconRail.tsx`
- `packages/ui/src/real/workspace/ProjectTabBar.tsx`
- `packages/ui/src/real/workspace/styles/center-pane.css`
- `packages/ui/src/real/workspace/styles/composer.css`
- `packages/ui/src/real/workspace/styles/icon-rail.css`
- `packages/ui/src/real/workspace/styles/project-tab-bar.css`
- `packages/ui/src/real/workspace/__tests__/centerPane.test.tsx`
- `packages/ui/src/real/workspace/__tests__/chrome.test.tsx`
- `packages/ui/src/real/workspace/__tests__/composer.test.tsx`
- `packages/server/src/pty/pty-ws-server.ts`
- `packages/pty-protocol/package.json`
- `packages/pty-protocol/src/index.ts`
- `packages/pty-protocol/test/parseControlFrame.test.ts`
- `packages/pty-protocol/test/goldenFrames.test.ts`
- `packages/pty-protocol/test/golden-frames.json`
- `docs/ui/audit/TERMINAL-TRANSPLANT-NOTES.md`

`packages/pty-protocol/src/index.ts` and its `parseControlFrame.test.ts` suite
are byte-identical to Maestro's current source. The golden JSON adds a
tool-independent drift check, including explicit `size.live === true` semantics.

## Deterministic checks

- UI TypeScript: exit 0 (`bunx tsc --noEmit --pretty false`).
- Server TypeScript: exit 0 (`bunx tsc -b packages/server --pretty false`).
- Protocol package: 2 files, 31 tests passed.
- Focused terminal/workspace suites: 6 files, 53 tests passed.
- Full UI suite: 80 files, 974 tests passed.
- Real PTY harness: 5/5 passed, including burst coalescing, offset replay,
  natural exit, non-zero exit, and explicit kill.

## Browser drive

Owned stack:

- UI `http://127.0.0.1:24611`
- server `http://127.0.0.1:24620`
- Postgres `:25442`
- scratch state `/tmp/tm8-lane-c-terminal.Pk5Jg9`
- echo run id `ms0od7o1`

Observed end to end:

1. Attach streamed `size`, then `attached`, then exactly one 363-byte binary
   replay. `TM8-ECHO-READY` rendered; initial FitAddon grid was 116×42.
2. Direct xterm input `lane-c-browser-roundtrip-ms0od7o1` travelled as binary
   frames and returned from the PTY as `TM8-ECHO: ...`.
3. A real left-grip drag held `maestro-sidebar-resizing` during the drag and
   removed it before the end event. FitAddon changed 116×42 → 102×42, sent one
   final resize, and a second subscriber received
   `{type:"size", cols:102, rows:42, live:true}` from the server.
4. With the PTY socket deliberately disconnected but the process alive,
   `lane-c-queued-while-disconnected-ms0od7o1` was absent before reconnect and
   echoed after reconnect at raw offset 444. The input was queued, not lost.
5. After session 1 fell out of the three-socket warm LRU and stayed hidden past
   grace, its socket closed. Re-showing it resumed at offset 541 and preserved
   all earlier output, proving suspend/flush/resume without a hole.
6. Opening five sessions held exactly four mounted xterms. Session 1 was
   evicted, then returned on a fresh `offset=0` socket; its earlier unique echo
   was recovered from the full retained ring. The mount count remained four.
7. A normal user click terminated the active echo agent. The real exit frame
   set `data-ended=true`; terminal input and termination controls were disabled.
8. Browser console errors: 0. Page errors: 0.

## Visual evidence

- Final idle pixel comparison: `side-by-side-full.png`
- Project tab comparison: `side-by-side-topbar.png`
- Icon rail comparison: `side-by-side-iconrail.png`
- Live terminal drive: `terminal-drive-1600x1000@2x.png`

The live-drive screenshot is intentionally post-resize and has a selected
session, so it is functional evidence rather than the idle pixel oracle. The
idle side-by-side files are the direct comparisons with `reference/00-full.png`,
`01-topbar.png`, and `02-iconrail.png`.

## Enumerated remaining differences

- tm8 maps Maestro's project switcher to real spaces. The isolated run has one
  space, while the reference has many projects; unsupported working/needs-input
  counts are omitted rather than invented as zero.
- The live-drive image shows real echo output, TerminalStrip, role chip and
  Composer; reference `00-full.png` has no selected terminal and therefore an
  idle near-black centre. The idle comparison uses the same state as reference.
- The permanent Real Server honesty banner is a tm8 addition. It floats at the
  bottom-left, is pointer-transparent, and no longer covers the centre action
  row. It is absent from Maestro.
- Idle target centre begins at x=342 versus reference x=344 because tm8 retains
  the real two-pixel resize seam. The terminal surface itself remains full-bleed
  and source-colored.
- All task/session titles and counts are real isolated-stack data, not copied
  reference fixtures.
