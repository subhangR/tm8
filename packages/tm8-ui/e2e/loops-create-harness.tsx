/**
 * The loops create flow, end to end in a real browser (loops PR6, design
 * 01a182d4 §6): the desktop loops list, its New loop form (pickers, presets,
 * timezone, the server's preview), and the loop page it opens (Run now and
 * the runs table). Every component is the shipped one; only the transport is
 * the fixture loops client, whose `schedulePreview` stands in for the server
 * (the form never computes a schedule, so the harness must answer for it).
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { EntityDetail, EntitySummary, SpaceId, ToolView } from '@tm8/contract';
import { createFixtureLoopsClient } from '../src/loops/fixture';
import { LoopsList } from '../src/loops/LoopsList';
import { LoopHeaderBlock, LoopRunsBlock } from '../src/loops/LoopPageBlocks';
import type { LoopFormSources } from '../src/loops/sources';
import '../src/styles/tokens.css';
import '../src/styles/canvas-extra.css';
import '../src/styles/app.css';
import '../src/kit/kit.css';
import '../src/panels/panels.css';
import '../src/authoring/authoring.css';

const SPACE = '019fe999-0000-7000-8000-00000000a000' as SpaceId;
const ADA = '019fe999-0000-7000-8000-00000000a001';
const summary = (id: string, kind: string, title: string) => ({ id, kind, title, spaceId: SPACE, state: { kind } }) as unknown as EntitySummary;

const loops = createFixtureLoopsClient();
// The server's answer for a preview: what `loops.schedule.preview` returns for these two schedules.
loops.schedulePreview = async (_space, schedule, timezone = 'UTC') => schedule === '0 9 * * 1-5'
  ? { valid: true, problem: null, summary: `Weekdays at 09:00 ${timezone}`, next: ['2026-11-02T09:00:00.000Z', '2026-11-03T09:00:00.000Z', '2026-11-04T09:00:00.000Z'] }
  : schedule.trim() === '' ? { valid: false, problem: 'schedule is required', summary: '', next: [] }
    : { valid: true, problem: null, summary: `Schedule ${schedule} (${timezone})`, next: [] };

const sources: LoopFormSources = {
  query: (async (input: { kinds?: string[] }) => ({
    page: { items: input.kinds?.[0] === 'team_member' ? [summary(ADA, 'team_member', 'Ada')] : [], nextCursor: null },
  })) as never,
  entity: (async (id: string) => ({ id, title: id === ADA ? 'Ada' : 'Entity', state: { kind: 'team_member' } })) as never,
  projects: (async () => []) as never,
  commands: { tools: { get: async () => { throw new Error('no tools in this harness'); } } as { get(id: string): Promise<ToolView> } },
};

function Harness() {
  const [open, setOpen] = useState<string | null>(null);
  const detail = open ? ({ id: open, kind: 'loop', title: '', version: loops.loops.get(open)?.version ?? 1, spaceId: SPACE } as unknown as EntityDetail) : null;
  return (
    <div className="cv2-root" data-theme="light" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: 16 }}>
      <LoopsList spaceId={SPACE} client={loops} sources={sources} onOpen={setOpen} selectedId={open} />
      <section aria-label="Loop page" data-testid="harness-loop-page">
        {detail ? (
          <>
            <LoopHeaderBlock detail={detail} port={loops} sources={sources} />
            <LoopRunsBlock detail={detail} port={loops} />
          </>
        ) : <p>Open a loop.</p>}
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
