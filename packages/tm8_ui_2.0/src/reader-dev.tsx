import React from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityDetail } from '@tm8/contract';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
/* THE HARNESS WAS LYING BY OMISSION UNTIL 2026-08-31. `panels/index.ts` pulls
   `honesty.css` in the real app; this file imported `panels.css` alone, so
   `.hon-tip` mounted with `position: static` here and wrapped harmlessly
   in-flow. The defect that prompted this pass is the ABSOLUTELY POSITIONED
   tooltip overflowing the scroller — a thing this harness was structurally
   incapable of showing. A scaffold that cannot reproduce the bug cannot prove
   the fix. */
import './panels/honesty/honesty.css';
import { ReaderBody } from './panels/bodies/ReaderBody';

/**
 * READER TABLE-OF-CONTENTS SCRATCH HARNESS — same spirit as terminal-dev.tsx
 * and artifact-dev.tsx: a gate-free mount for pixel-verifying ONE surface, here
 * the reader's outline. Not product code, never imported by anything else, and
 * it needs no node and no credentials — the detail below is a literal.
 *
 * WHY A BROWSER HARNESS IS NOT OPTIONAL FOR THIS CHANGE. jsdom loads no
 * stylesheets, so `ReaderBody.test.tsx` can prove which heading a jump targets
 * and cannot see ANY of what the change is mostly made of: whether the list
 * reads as a list, whether the depth indent is visible, whether a long label
 * wraps to two lines instead of being sliced, and whether the scroll actually
 * moves the panel. The panel is also the scroll container (`.pn-body` is
 * `overflow:auto`), which is precisely the kind of fact a layout-less test
 * environment cannot have an opinion about.
 *
 * THE FIXTURE IS THE REAL DOCUMENT'S SHAPE — the heading tree of "Mobile +
 * PWA: the plan and the orchestration" (doc 01a00ba4), the doc in the report
 * that prompted this change: 17 headings, two `#` sections with `##` children,
 * one heading carrying a code span, and two headings whose text is long enough
 * to have been ellipsed by the pill it replaced. Prose is filler; the outline
 * is what is under test, and the filler is what makes the column tall enough
 * for a jump to be observable.
 *
 * Usage: /reader-dev.html
 */

const FILLER = [
  'Every shrinkable region states a floor — this app has been broken three',
  'separate times by flex tracks with zero minimums, so floors are law rather',
  'than preference. The paragraph exists to give the column height, so that a',
  'jump from the outline above has somewhere to arrive.',
].join(' ');

const HEADINGS: readonly string[] = [
  '# Fully mobile-responsive tm8, and a PWA — the plan',
  '## 0. Correcting the premise, because it changes the plan',
  '## 1. What a phone actually gets today — measured',
  '## Phase 3a — Make the shell look like an app  ·  1 lane, ~1 day',
  '## Phase 3b — Phone screens, not squeezed desktop screens  ·  1–2 lanes',
  '## Phase 3c — The seven missing destinations  ·  1 lane each, parallelisable',
  '## Phase 4 — Touch correctness  ·  1 lane',
  '## Phase 5 — The PWA  ·  1 lane',
  '## Phase 6 — Lifecycle for a backgrounded phone  ·  small, do it with Phase 5',
  '## Phase 7 — The `zoom: 1.1` decision  ·  needs your call',
  '### A third level, to show the indent step',
  '## Proof standard',
  '## Decisions I need from you',
  '# The orchestration — roster, lanes and sequencing',
  '## Roster',
  '## Lanes and dependency graph',
  '## Owner rulings baked into every persona',
  '## Proof standard',
  '## Spawn hazard the Lead must respect',
];

const BODY = HEADINGS.flatMap((h) => [h, '', FILLER, '']).join('\n');

const detail = {
  id: 'doc-mobile-pwa',
  spaceId: 'sp-dev',
  kind: 'doc',
  title: 'Mobile + PWA: the plan and the orchestration',
  parentId: null,
  position: 0,
  visibility: 'space',
  version: 1,
  activityAt: '2026-08-16T17:35:26.504Z',
  createdAt: '2026-08-16T17:35:26.357Z',
  updatedAt: '2026-08-16T17:35:26.357Z',
  deletedAt: null,
  createdBy: { id: 'm-dev', kind: 'member', displayName: 'dev', isAgent: false },
  counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
  state: { kind: 'doc', format: 'markdown', childCount: 0 },
  badges: {},
  content: { kind: 'doc', body: BODY, format: 'markdown' },
  hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
  connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
  capabilities: {
    canEdit: true,
    canDelete: false,
    canAddChild: true,
    canLink: true,
    canPull: false,
    canReact: true,
    canGrantPoints: false,
    canComplete: false,
  },
} as unknown as EntityDetail;

/**
 * A `.pn-panel`-shaped box with a BOUNDED height, because the scroll is the
 * point: `.pn-body` only scrolls when its content exceeds it, and a harness
 * that let the page grow would show the list correctly and never exercise the
 * jump at all.
 */
/* ══ THE SECOND FIXTURE — A REAL DOCUMENT, VERBATIM ═════════════════════════
   Added 2026-08-31 for the document-rendering pass. The outline fixture above
   is deliberately filler-bodied, which is right for testing an outline and
   useless for testing a DOCUMENT: it contains no table, no fence, no quote and
   no diagram, and those are what documents in this space are actually made of.

   The 40 documents in the live space were read to decide what this needed to
   contain. 27 of them carry a table (one carries 95 rows); 18 carry a fence;
   ONE carries a mermaid diagram; NONE carries a callout. So the passages below
   are quoted from the real records rather than invented:

     · the opening, the `33 files changed` fence, and the PR table are
       `01a04ee0` "Frontend verification — what changed on 2026-08-29", which is
       the document the owner screenshotted;
     · the status banner is `01a027b5` "DESIGN 1 — Harness registry (Phase 0)",
       quoted to show what a twelve-line blockquote-as-banner looks like now
       that blockquotes are not italic, and what the same content looks like as
       a callout underneath it;
     · the callouts and the diagram are the two shapes NO document uses yet, and
       they are here because the reason nobody writes them is that they rendered
       as nothing. */
const REAL_BODY = [
  '# Frontend verification — what changed on 2026-08-29',
  '',
  'Verified directly against the repository, not from session reports. Base is',
  '`41c824b4` (main immediately before the train). Head is `6423d07d`, the commit',
  'deployed to production.',
  '',
  '> **STATUS BANNER — added 22 Aug 2026 during the build of this task.**',
  '> **Every count in §1 is stale.** They were read at `8e6e1527`, **573 commits',
  '> behind main**. They have not been re-derived, and nothing below should be',
  '> trusted as a current measurement — only as a shape.',
  '',
  '> [!WARNING]',
  '> The same words, in the vocabulary the renderer now has. Every count in §1 is',
  '> stale — read at `8e6e1527`, 573 commits behind main.',
  '',
  '> [!NOTE]',
  '> A note is the quiet one: context a reader can take or leave.',
  '',
  '> [!CAUTION]',
  '> A caution is the loud one, and it is the same red as a blocked session.',
  '',
  '## The whole change, measured',
  '',
  '```',
  '33 files changed, 3587 insertions(+), 215 deletions(-)',
  '```',
  '',
  'Every one of those 33 files is under `packages/tm8_ui_2.0`. Nothing in the',
  'server, contract, CLI, execution or MCP packages moved. This was a pure',
  'frontend train.',
  '',
  '### What merged, in order',
  '',
  '| PR | Merge SHA | Subject |',
  '|---|---|---|',
  '| #550 | `10307c80` | redesign task detail surface |',
  '| #545 | `ac1c7235` | redesign Home and shared entity navigation |',
  '| #549 | `322ae63e` | cluster prose legibility |',
  '| #544 | `6423d07d` | improve Help discovery for new users |',
  '| #551 | `b09e792e` | before/after evidence artifact (docs only) |',
  '',
  '#### A fourth level, which used to look identical to the third',
  '',
  '- `EntityCreateControl` picks a flow from the registry.',
  '- `NewTaskControl` renders one button wearing `.lp__new`.',
  '- The row is written immediately. There is no intermediate card to redesign.',
  '',
  '##### A fifth level',
  '',
  '###### And a sixth, which is an eyebrow now',
  '',
  'A long unbreakable token is the second way a reading column gets pushed past',
  'its box: `packages/tm8_ui_2.0/src/panels/bodies/ReaderBody.tsx` must wrap, not',
  'widen.',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[doc body] --> B{fence?}',
  '  B -->|mermaid| C[drawn]',
  '  B -->|other| D[code block]',
  '```',
].join('\n');

const realDetail = {
  ...(detail as unknown as Record<string, unknown>),
  id: 'doc-frontend-verification',
  title: 'Frontend verification — what changed on 2026-08-29',
  content: { kind: 'doc', body: REAL_BODY, format: 'markdown' },
} as unknown as EntityDetail;

function Panel({ theme, doc }: { theme?: 'dark'; doc: EntityDetail }) {
  return (
    <div className="cv2-root" data-theme={theme} style={{ background: 'var(--pn-paper)', padding: 16 }}>
      <div
        className="pn-panel"
        style={{ height: 560, width: 460, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <ReaderBody
          detail={doc}
          blocks={[]}
          historyUnavailableReason="Version history is not built in this build."
          onOpenEntity={undefined}
        />
      </div>
    </div>
  );
}

function Harness() {
  // Both themes, side by side — the outline's hover and focus treatments are
  // token-driven and a dark-only regression is invisible in a light-only shot.
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <Panel doc={detail} />
        <Panel doc={detail} theme="dark" />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }} data-testid="real-doc-row">
        <Panel doc={realDetail} />
        <Panel doc={realDetail} theme="dark" />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
