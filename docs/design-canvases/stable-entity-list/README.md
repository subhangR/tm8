# Stable entity list — interactive design study

Reviewable prototype for the entity panel redesign. This PR changes only the
study under `docs/design-canvases/stable-entity-list`; it does not integrate the
behavior into the production app or launch real sessions.

## Run and test

From the repository root:

```sh
python3 -m http.server 8787 --bind 127.0.0.1 --directory docs/design-canvases/stable-entity-list
```

Open http://127.0.0.1:8787. No build or service credentials are required.
Use **Reset demo** to restore the fixture. Edits persist in this browser's
localStorage under `tm8-stable-panel-design-v1`.

```sh
node --test docs/design-canvases/stable-entity-list/model.test.mjs
# With repo dependencies installed:
node --test docs/design-canvases/stable-entity-list/dom.test.mjs
# With the repo dependencies and Playwright Chromium installed, while serving:
node docs/design-canvases/stable-entity-list/browser.test.mjs
```

The browser test accepts `PROTOTYPE_URL`, `SCREENSHOT_DIR`, `PLAYWRIGHT_MODULE`
(an alternate installed module path), and `CHROMIUM_PATH` when needed by the host.

## Confirmed choices

- All entities retain their manual sibling order until deliberately moved.
- Status, activity, and unread changes update rows in place. No live/completed
  grouping automatically transfers a session to another section.
- New roots enter at the top of their kind's root list; new children enter at
  the top of their parent's children. Existing rows retain relative order.
  Thus “stable” means stable placement, not a fixed screen pixel: insertion and
  expansion can push rows down.
- New opens a provisional detail tab immediately and focuses the inline title.
  Both title fields share one draft. Enter saves; Escape discards the new draft.
  Empty titles do not create saved entities. An explicit save button is also
  available. Existing title edits cannot become empty.
- Sessions support manual reorder and reparent, like other kinds. Parents and
  children are the same kind. A move carries the entire subtree.
- Keep the existing panel's visual vocabulary: Atelier paper/ink/brass tokens,
  Hanken Grotesk, Newsreader, compact rows, subdued metadata, dashed New control.

## Try these interactions

1. New → type a title → watch its tab and title field update → Enter.
2. Add subtask → create several children → collapse and expand their parent.
3. Grab a handle. The upper/lower edges place a row before/after a sibling;
   the center highlights a prospective parent. Release to move; Escape cancels.
   The hit-test geometry stays fixed during the preview so the moving gap does
   not oscillate. Surrounding rows slide for 200 ms; reduced motion skips it.
4. Use a row's menu for Move to…, Move up/down, Indent, and Outdent. Move to…
   excludes the entity and all its descendants. It inserts at the destination's
   top. Indent uses the previous sibling; outdent places after the old parent.
5. Focus a row and use Alt+arrows for those movement actions, plain Up/Down to
   traverse visible rows, or Enter to open its tab. Dragging is not required.
6. Switch to Sessions and simulate activity three times. The status and unread
   badge change; the IDs and parent/order stay identical. Completed stays visible.
7. Switch to Docs or Artifacts and repeat the same creation/movement flow.
8. Undo a placement. Reload to check persisted positions. Search matches retain
   their ancestors; placement controls are disabled until search is cleared.
9. Toggle dark mode or narrow the viewport. On mobile the detail follows the
   list vertically. Menus provide movement without a precision drag gesture.

## Integration boundary and follow-up

This study deliberately uses local demo data. Creation of a session previews
placement and title editing, not a substitute for the real launch composer.
The static example kinds demonstrate shared behavior; production availability
must continue to follow the kind registry and capabilities (not hardcoded kinds).

Production integration must use a persisted sibling rank per parent/kind, with
new entities inserted first and status/activity absent from ordering. It needs
server-authorized, versioned moves, same-kind/cycle guards, transactional updates,
rollback and a visible failure state. Concurrent edits and partially loaded trees
must resolve against server placement, not infer a complete order from a page.
User-selected filtered views may hide rows but must not rewrite placement.

Relevant existing integration points inspected:

- `packages/tm8-ui/src/panels/EntityListPanel.tsx`: universal tree/list, creation
  callback, sorting, session grouping, existing attention-in-place treatment.
- `packages/tm8-ui/src/tab-workspace/view/browser.css`: dashed New control.
- `packages/tm8-ui/src/styles/tokens.css` and `fonts.css`: Atelier styling.

The prototype copies three existing self-hosted font files so the published
artifact is standalone and works without external font requests.

## Validation receipt

Model tests cover top insertion, stable lifecycle updates, subtree preservation,
serialized order, cycle/cross-kind guards, and collapse visibility. DOM tests
exercise creation, bidirectional title sync, child creation, draft cancellation,
keyboard/menu moves, undo, stable session updates, kind switching, and search.

The committed browser smoke test also covers pointer drops, drag cancellation,
reload, screenshots, narrow viewport, and reduced motion. Chromium on the authoring
host crashes while creating its first page, before loading this prototype, so
those visual/browser checks could not be completed here. Run that script on a
working Playwright installation and manually judge drag smoothness during review.
