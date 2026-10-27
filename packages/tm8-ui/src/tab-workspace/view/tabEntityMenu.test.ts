import { describe, expect, it, vi } from 'vitest';
import type { SessionTranscriptPage } from '@tm8/contract';
import type { ActionContext } from '../../domain';
import { PANEL_PRIMARY_ACTIONS } from '../../views/usePanelPrimaries';
import { entityMenuItems, readTranscriptText, type EntityMenuFacts } from './tabEntityMenu';

const ports = () => ({
  showSubview: vi.fn(),
  runVerb: vi.fn(),
  copy: vi.fn(),
  copyLink: vi.fn(),
  copyTranscript: vi.fn(),
});

const facts = (over: Partial<EntityMenuFacts> = {}): EntityMenuFacts => ({
  entityId: 'e1',
  kind: 'task',
  noun: 'Task',
  title: 'Fix the tabs',
  subview: 'entity',
  sections: true,
  ctx: { spaceId: 's1', entityId: 'e1', kind: 'task' } as ActionContext,
  wired: [...PANEL_PRIMARY_ACTIONS, 'complete-session', 'reopen-session'],
  ...over,
});

describe('entityMenuItems', () => {
  it('offers the sections, then the copies, for any entity', () => {
    const p = ports();
    const items = entityMenuItems(facts({ subview: 'connections' }), p);
    expect(items.map((i) => i.key)).toEqual([
      'view-entity', 'view-connections', 'view-messages', 'copy-id', 'copy-title', 'copy-link', 'copy-cli',
    ]);
    expect(items.find((i) => i.key === 'view-connections')?.checked).toBe(true);
    expect(items.find((i) => i.key === 'copy-id')?.divider).toBe(true);
    items.find((i) => i.key === 'copy-cli')!.run('click');
    expect(p.copy).toHaveBeenCalledWith('tm8 entity context e1', 'CLI command');
    items.find((i) => i.key === 'view-messages')!.run('click');
    expect(p.showSubview).toHaveBeenCalledWith('messages');
  });

  it('a canvas kind has no sections', () => {
    const items = entityMenuItems(facts({ sections: false }), ports());
    expect(items[0]?.key).toBe('copy-id');
    expect(items[0]?.divider).toBe(false);
  });

  it('a session adds its process verb, its id label and its transcript', () => {
    const p = ports();
    const ctx = {
      spaceId: 's1',
      entityId: 'w1',
      kind: 'work_session',
      liveness: 'live',
      category: 'in_progress',
      capabilities: null,
    } as unknown as ActionContext;
    const items = entityMenuItems(facts({ entityId: 'w1', kind: 'work_session', noun: 'Session', ctx }), p);
    const keys = items.map((i) => i.key);
    expect(keys).toContain('verb-terminate');
    expect(keys).toContain('copy-transcript');
    expect(items.find((i) => i.key === 'copy-id')?.label).toBe('Copy session ID');
    items.find((i) => i.key === 'verb-terminate')!.run('click');
    expect(p.runVerb).toHaveBeenCalledWith('terminate');
  });

  it('an ended session offers Resume instead of Terminate', () => {
    const ctx = { spaceId: 's1', entityId: 'w1', kind: 'work_session', liveness: 'dead', category: 'done' } as unknown as ActionContext;
    const keys = entityMenuItems(facts({ entityId: 'w1', kind: 'work_session', ctx }), ports()).map((i) => i.key);
    expect(keys).toContain('verb-resume');
    expect(keys).not.toContain('verb-terminate');
  });
});

const page = (over: Partial<SessionTranscriptPage>): SessionTranscriptPage =>
  ({
    sessionId: 'w1',
    available: true,
    unavailableReason: null,
    searchedPaths: [],
    agentTool: 'claude-code',
    entries: [],
    stats: null,
    stuck: null,
    lastActivityAt: null,
    malformed: 0,
    windowStart: 0,
    hasOlder: false,
    ...over,
  }) as SessionTranscriptPage;

describe('readTranscriptText', () => {
  it('pages back to the start and joins oldest first', async () => {
    const read = vi.fn(async (opts: { before?: number }) =>
      opts.before === undefined
        ? page({ entries: [{ at: null, source: 'assistant', text: 'second', truncated: false }], windowStart: 10, hasOlder: true })
        : page({ entries: [{ at: null, source: 'user', text: 'first', truncated: false }], windowStart: 0, hasOlder: false }),
    );
    const { text, complete } = await readTranscriptText(read);
    expect(complete).toBe(true);
    expect(read).toHaveBeenLastCalledWith({ last: 200, before: 10 });
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
  });

  it('says why when there is no transcript', async () => {
    await expect(
      readTranscriptText(async () => page({ available: false, unavailableReason: 'no_transcript_file', windowStart: null })),
    ).rejects.toThrow('No transcript has been written');
  });
});
