import React from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityDetail } from '@tm8/contract';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import './panels/panels.css';
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
function Panel({ theme }: { theme?: 'dark' }) {
  return (
    <div className="cv2-root" data-theme={theme} style={{ background: 'var(--pn-paper)', padding: 16 }}>
      <div
        className="pn-panel"
        style={{ height: 560, width: 460, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <ReaderBody
          detail={detail}
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
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <Panel />
      <Panel theme="dark" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
