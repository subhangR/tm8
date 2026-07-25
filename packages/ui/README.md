# @tm8/ui

Web app (AM-1: no desktop shell). Populated at M2 (W3) by Atlas's team:
transplant of `maestro-ui/src/collab-v2/` (built self-contained on the
feat/collab-v2-ui worktree) + `RealFacade implements CollabFacade` over
tm8-server HTTP/WS + runtime KindRegistry path + terminal components
(xterm WebGL-on-Chromium with DOM fallback, unmount-on-exit, bounded log memory).

Vite dev server: port **4611**. Production: built bundle served by tm8-server (4610).
Do not scaffold a Vite app here before W3 — the transplant brings its own structure.
