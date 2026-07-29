# 09 — HTML

Three files, three different kinds of artifact. Read the labels before using any of them.

| File | What it is | Honesty note |
|---|---|---|
| `tm8-workspace-static.html` | **Generated static rendering of tm8's current Workspace view** (the maestro `pn-*` transplant at `#/s/{space}/workspace`). Open it in any browser; no network needed (the Google-Fonts `@import` upgrades typography when online, system fonts otherwise). The `<style>` block is the **real, unmodified repo CSS** concatenated in order (tokens.css + the seven workspace stylesheets); the markup is hand-assembled to mirror the real components' class structure with representative data. | Faithful in structure and styling, **not** a byte capture of the runtime DOM: icon SVGs are simplified glyphs, and the live xterm canvas is a static `<pre>` stand-in (the real terminal is a verbatim maestro transplant and is out of design scope anyway). The only non-repo CSS sits at the end of the style block under a marked "static-mockup-only additions" banner. |
| `maestro-app-ui.html` | **Found artifact**: a genuine self-contained static mockup of the maestro app UI, copied from `~/Desktop/Projects/maestro/agent-maestro/design/maestro-app-ui.html`. Zero external dependencies. Useful as a hand-drawn ancestor reference for the chrome (top bar, rails, panel rhythm). | Its token values are an earlier/looser cousin of the canonical ATELIER set in `03-DESIGN-LANGUAGE.md` — treat ATELIER as authoritative where they differ. |
| `vite-index.html` | Copy of `packages/ui/index.html` from the tm8 repo. | **This is a Vite mount point, not a mockup** — a bare shell that loads the React app; it renders nothing on its own. Included only because it is the repo's one true HTML file. |

Search note: `~/Desktop/Projects/maestro` and `~/Desktop/workspace` were searched for other static mockups. `~/Desktop/workspace/notes/Maestro Collab Space.html` and `Maestro Spells (standalone).html` exist but are bundler-generated app snapshots (JS-loading shims), not editable mockups, so they were not copied.
