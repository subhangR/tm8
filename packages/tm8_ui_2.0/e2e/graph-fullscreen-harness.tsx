import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EdgeView, EntityId, Page } from '@tm8/contract';
import { ChatEntityGraph } from '../src/chat-home/ChatEntityGraph';
import { measuredConnections, measuredSeeds, T1 } from '../src/chat-home/induced-graph.fixture';
import type { ChatTurn, ChatTurnPart } from '../src/chat-home/types';
import type { ConnectionsReader } from '../src/session-graph/load';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';

/**
 * PIXEL harness for plan 01a0094b Part A (PRs B–D): the fullscreen entity
 * graph dialog, its pan/zoom, the filter rail and the selection detail
 * panel — every one of which is a LAYOUT fact jsdom cannot see (the vitest
 * suite proves structure and arithmetic; only a browser proves the dialog
 * covers the screen, the rail fits, dimming reads, and drag actually pans).
 *
 * FIXTURES, NOT THE REAL SEAM, ON PURPOSE: the measured ten-seed mix puts
 * every state on screen deterministically — hubs, an isolated channel, a
 * failed read, a mutated task — without needing a server or a live thread.
 *
 * The `expanded`/`gf` pair is two useState cells, exactly the shape the
 * route hands the real host.
 *
 *   /e2e/graph-fullscreen-harness.html
 */
let seq = 0;
const call = (name: string, args: unknown): ChatTurnPart[] => [
  { kind: 'tool_call', seq: (seq += 1), toolCallId: `tc-${(seq += 1)}`, name, args, state: 'completed' },
];
const turnOf = (parts: ChatTurnPart[]): ChatTurn => ({
  messageId: `msg-${(seq += 1)}` as EntityId,
  role: 'assistant',
  author: null,
  createdAt: '2026-08-16T10:00:00.000Z',
  body: '',
  parts,
});
const turns: ChatTurn[] = [
  turnOf(
    measuredSeeds().flatMap((seed) =>
      call(seed.id === T1 ? 'tm8_update_entity' : 'tm8_read', { id: seed.id }),
    ),
  ),
];

const pages = measuredConnections();
const read: ConnectionsReader = (id) => {
  const page = pages.get(id);
  if (!page || page.state !== 'loaded') return Promise.reject(new Error('403'));
  return Promise.resolve({
    items: page.edges as EdgeView[],
    nextCursor: page.pageCapped ? 'more' : null,
  } as unknown as Page<EdgeView>);
};

function Harness() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [expanded, setExpanded] = useState(false);
  const [gf, setGf] = useState<string | null>(null);
  const [opened, setOpened] = useState<string[]>([]);
  return (
    <div className="cv2-root" data-theme={theme === 'dark' ? 'dark' : undefined}>
      <div className="harness-page">
        <div className="harness-bar">
          <button type="button" data-testid="theme-toggle" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            theme: {theme}
          </button>
          <code data-testid="route-echo">{`graph=${expanded ? 'full' : '–'} gf=${gf ?? '–'}`}</code>
          <code data-testid="opened-echo">{opened.length ? `opened: ${opened.join(',')}` : 'opened: —'}</code>
        </div>
        <div className="harness-chat">
          <ChatEntityGraph
            turns={turns}
            connections={read}
            expanded={expanded}
            onExpandedChange={setExpanded}
            graphFilters={gf}
            onGraphFiltersChange={setGf}
            onOpenEntity={(id) => setOpened((prev) => [...prev, id])}
          />
          <p className="harness-filler">
            The conversation body sits here — the strip above must stay calm inside a chat column.
          </p>
        </div>
      </div>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; font-family: system-ui, sans-serif; }
  .harness-page { min-height: 100vh; background: var(--pn-bg, #f2efe9); padding: 16px; }
  .harness-bar { display: flex; gap: 12px; align-items: center; margin: 0 0 12px; font-size: 12px; }
  .harness-chat { max-width: 760px; margin: 0 auto; }
  .harness-filler { color: var(--pn-ink-3, #888); font-size: 13px; }
`;
document.head.append(style);
createRoot(document.getElementById('root')!).render(<Harness />);
