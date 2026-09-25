// @vitest-environment jsdom
/**
 * Entity chat, lane C (design 01a0da4e §3.4): the skip-when-default rule and
 * the new-chat settings card — driven through `NewChatSettings` (the slot's
 * default gate) against a fake seam, with the composer stubbed to print the
 * seed it was started with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatDefaultsMap, EntityId } from '@tm8/contract';
import { modelCatalog } from '../domain/model-catalog';
import { navStore, resetNav } from '../stores/navStore';
import type { NewChatSeed } from '../chat-home/types';
import { EntityChatSlot, NewChatSettings } from './index';

vi.mock('../views/conversationSurface', () => ({
  entityChatSurfaceFor: (_about: string, thread: string, _host: unknown, _select: unknown, seed?: NewChatSeed) => (
    <div data-testid="slot-composer" data-thread={thread}>{JSON.stringify(seed ?? null)}</div>
  ),
}));

const SPACE = 'sp-c';
const TASK = '01a0-task' as EntityId;
const ADA = '01a0-ada';
const BOB = '01a0-bob';
const [MODEL_A, MODEL_B] = modelCatalog('local').map((model) => model.model);

interface FakeOpts {
  defaults?: ChatDefaultsMap;
  entityProject?: string | null;
  spaceProject?: string | null;
  setRefuses?: string;
}

function fakeSeam(opts: FakeOpts = {}) {
  let defaults: ChatDefaultsMap = { ...(opts.defaults ?? {}) };
  let revision = 1;
  const view = () => ({ spaceId: SPACE, defaults, revision });
  const projectRow = (id: string, title: string) => ({ id: `ent-${id}`, title, state: { kind: 'project', projectId: id } });
  return {
    chatDefaults: vi.fn(async () => view()),
    setChatDefaults: vi.fn(async (_space: string, patch: Record<string, unknown>) => {
      if (opts.setRefuses) throw new Error(opts.setRefuses);
      defaults = { ...defaults, ...(patch as ChatDefaultsMap) };
      revision += 1;
      return view();
    }),
    query: vi.fn(async (q: { kinds: string[] }) => ({
      page: {
        items: q.kinds[0] === 'team_member'
          ? [{ id: ADA, title: 'Ada' }, { id: BOB, title: 'Bob' }]
          : [projectRow('p-own', 'Own repo'), projectRow('p-space', 'Space repo')],
        nextCursor: null,
      },
    })),
    projects: vi.fn(async () => (opts.spaceProject ? [{ id: opts.spaceProject, name: 'Space repo', trust: 'trusted' }] : [])),
    connections: vi.fn(async () => ({
      items: opts.entityProject ? [{ type: 'in_project', target: projectRow(opts.entityProject, 'Own repo') }] : [],
      nextCursor: null,
    })),
    entity: vi.fn(async (id: string) => ({ id, title: 'Task A', kind: 'task' })),
  };
}

function mount(seam: ReturnType<typeof fakeSeam>, kind = 'task') {
  const composerFor = vi.fn((seed: NewChatSeed) => <div data-testid="composer">{JSON.stringify(seed)}</div>);
  render(
    <NewChatSettings seam={seam as never} spaceId={SPACE} nodeKey="local" subject={{ id: TASK, kind }} composerFor={composerFor} />,
  );
  return composerFor;
}

const seedShown = () => JSON.parse(screen.getByTestId('composer').textContent ?? 'null') as NewChatSeed;

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('the skip-when-default rule (§3.4 rule 1)', () => {
  it('a full default that resolves opens the composer with it — no card; mode = last used, project = the entity’s own', async () => {
    localStorage.setItem('tm8.chat.lastMode', 'plan');
    const seam = fakeSeam({ defaults: { task: { teammateId: BOB as EntityId, model: MODEL_B } }, entityProject: 'p-own', spaceProject: 'p-space' });
    mount(seam);
    await waitFor(() => screen.getByTestId('composer'));
    expect(screen.queryByTestId('new-chat-card')).toBeNull();
    expect(seedShown()).toEqual({ teammateId: BOB, model: MODEL_B, mode: 'plan', projectId: 'p-own' });
  });

  it('mode falls back to ask and project to the space’s, then scratch', async () => {
    mount(fakeSeam({ defaults: { task: { teammateId: ADA as EntityId, model: MODEL_A } }, spaceProject: 'p-space' }));
    await waitFor(() => screen.getByTestId('composer'));
    expect(seedShown()).toMatchObject({ mode: 'ask', projectId: 'p-space' });
    cleanup();
    mount(fakeSeam({ defaults: { task: { teammateId: ADA as EntityId, model: MODEL_A } } }));
    await waitFor(() => screen.getByTestId('composer'));
    expect(seedShown()).toMatchObject({ projectId: null });
  });

  it('re-reads the defaults on every new chat instead of trusting the shared cache', async () => {
    const seam = fakeSeam();
    mount(seam);
    await waitFor(() => screen.getByTestId('new-chat-card'));
    cleanup();
    mount(seam);
    await waitFor(() => screen.getByTestId('new-chat-card'));
    /* One forced read per mount (the hook's own cached read shares the first). */
    expect(seam.chatDefaults.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the settings card (§3.4 rule 2)', () => {
  it('no default: the card, pre-filled, and nothing is created', async () => {
    const seam = fakeSeam({ entityProject: 'p-own' });
    const composerFor = mount(seam);
    await waitFor(() => screen.getByTestId('new-chat-card'));
    expect(screen.getByTestId('new-chat-card').textContent).toContain('No default for Task chats yet.');
    expect((screen.getByTestId('new-chat-teammate') as HTMLSelectElement).value).toBe(ADA);
    expect((screen.getByTestId('new-chat-model') as HTMLSelectElement).value).toBe(MODEL_A);
    expect((screen.getByTestId('new-chat-mode') as HTMLSelectElement).value).toBe('ask');
    expect((screen.getByTestId('new-chat-project') as HTMLSelectElement).value).toBe('p-own');
    expect(screen.getByTestId('new-chat-use-for-kind').parentElement?.textContent).toContain('Use for every Task chat');
    expect(composerFor).not.toHaveBeenCalled();
    expect(seam.setChatDefaults).not.toHaveBeenCalled();
  });

  it('half a default: the card, with the half that resolved pre-filled', async () => {
    mount(fakeSeam({ defaults: { task: { model: MODEL_B } } }));
    await waitFor(() => screen.getByTestId('new-chat-card'));
    expect(screen.getByTestId('new-chat-card').textContent).toContain('Task chats have a default model but no teammate.');
    expect((screen.getByTestId('new-chat-model') as HTMLSelectElement).value).toBe(MODEL_B);
  });

  it('a stale model is NAMED on the card, never swapped silently', async () => {
    mount(fakeSeam({ defaults: { task: { teammateId: BOB as EntityId, model: 'claude-retired-1' } } }));
    await waitFor(() => screen.getByTestId('new-chat-card'));
    expect(screen.getByTestId('new-chat-problems').textContent).toContain('default model claude-retired-1 is no longer offered');
    expect((screen.getByTestId('new-chat-teammate') as HTMLSelectElement).value).toBe(BOB);
  });

  it('Start chat collapses the card into the composer, seeded with the card’s choices and focus', async () => {
    mount(fakeSeam());
    await waitFor(() => screen.getByTestId('new-chat-card'));
    fireEvent.change(screen.getByTestId('new-chat-teammate'), { target: { value: BOB } });
    fireEvent.change(screen.getByTestId('new-chat-model'), { target: { value: MODEL_B } });
    fireEvent.change(screen.getByTestId('new-chat-mode'), { target: { value: 'build' } });
    fireEvent.change(screen.getByTestId('new-chat-project'), { target: { value: 'p-space' } });
    fireEvent.click(screen.getByTestId('new-chat-start'));
    await waitFor(() => screen.getByTestId('composer'));
    expect(screen.queryByTestId('new-chat-card')).toBeNull();
    expect(seedShown()).toEqual({ teammateId: BOB, model: MODEL_B, mode: 'build', projectId: 'p-space', focus: true });
    /* …and the mode is what the NEXT new chat starts in. */
    expect(localStorage.getItem('tm8.chat.lastMode')).toBe('build');
  });

  it('"Use for every ‹Kind› chat" writes the kind’s default, then starts with the card’s choices', async () => {
    const seam = fakeSeam();
    mount(seam);
    await waitFor(() => screen.getByTestId('new-chat-card'));
    fireEvent.change(screen.getByTestId('new-chat-mode'), { target: { value: 'plan' } });
    fireEvent.click(screen.getByTestId('new-chat-use-for-kind'));
    fireEvent.click(screen.getByTestId('new-chat-start'));
    await waitFor(() => screen.getByTestId('composer'));
    expect(seam.setChatDefaults).toHaveBeenCalledWith(SPACE, { task: { teammateId: ADA, model: MODEL_A } });
    expect(seedShown()).toMatchObject({ mode: 'plan', focus: true });
  });

  it('a second new chat with no default pre-fills the teammate and model used last', async () => {
    mount(fakeSeam());
    await waitFor(() => screen.getByTestId('new-chat-card'));
    fireEvent.change(screen.getByTestId('new-chat-teammate'), { target: { value: BOB } });
    fireEvent.change(screen.getByTestId('new-chat-model'), { target: { value: MODEL_B } });
    fireEvent.click(screen.getByTestId('new-chat-start'));
    await waitFor(() => screen.getByTestId('composer'));
    cleanup();
    mount(fakeSeam());
    await waitFor(() => screen.getByTestId('new-chat-card'));
    expect((screen.getByTestId('new-chat-teammate') as HTMLSelectElement).value).toBe(BOB);
    expect((screen.getByTestId('new-chat-model') as HTMLSelectElement).value).toBe(MODEL_B);
  });

  it('the kind default outranks last used; a stale last used falls through to the first listed', async () => {
    localStorage.setItem('tm8.chat.lastTeammate', BOB);
    localStorage.setItem('tm8.chat.lastModel', MODEL_B);
    mount(fakeSeam({ defaults: { task: { teammateId: ADA as EntityId } } }));
    await waitFor(() => screen.getByTestId('new-chat-card'));
    expect((screen.getByTestId('new-chat-teammate') as HTMLSelectElement).value).toBe(ADA);
    expect((screen.getByTestId('new-chat-model') as HTMLSelectElement).value).toBe(MODEL_B);
    cleanup();
    localStorage.setItem('tm8.chat.lastTeammate', '01a0-left-the-space');
    localStorage.setItem('tm8.chat.lastModel', 'claude-retired-1');
    mount(fakeSeam());
    await waitFor(() => screen.getByTestId('new-chat-card'));
    expect((screen.getByTestId('new-chat-teammate') as HTMLSelectElement).value).toBe(ADA);
    expect((screen.getByTestId('new-chat-model') as HTMLSelectElement).value).toBe(MODEL_A);
  });

  it('a refused write is shown on the card, and the card stays', async () => {
    mount(fakeSeam({ setRefuses: 'only a space admin can set chat defaults' }));
    await waitFor(() => screen.getByTestId('new-chat-card'));
    fireEvent.click(screen.getByTestId('new-chat-use-for-kind'));
    fireEvent.click(screen.getByTestId('new-chat-start'));
    await waitFor(() => screen.getByTestId('new-chat-error'));
    expect(screen.getByTestId('new-chat-error').textContent).toContain('only a space admin can set chat defaults');
    expect(screen.queryByTestId('composer')).toBeNull();
  });
});

describe('every slot host gets the gate (EntityChatSlot default)', () => {
  beforeEach(() => resetNav(SPACE));

  it('a new chat with no default shows the card in the panel; Start chat hands the seed to the slot composer', async () => {
    const seam = { ...fakeSeam(), onEvent: () => () => {} };
    act(() => navStore.getState().openChat({ about: TASK, thread: 'new' }));
    render(
      <EntityChatSlot seam={seam as never} spaceId={SPACE} nodeKey="local" onOpenEntity={() => {}} subjectOf={() => ({ title: 'Task A', kind: 'task' })} />,
    );
    await waitFor(() => screen.getByTestId('new-chat-card'));
    expect(screen.getByTestId('entity-chat-panel').contains(screen.getByTestId('new-chat-card'))).toBe(true);
    expect(screen.queryByTestId('slot-composer')).toBeNull();
    fireEvent.click(screen.getByTestId('new-chat-start'));
    await waitFor(() => screen.getByTestId('slot-composer'));
    expect(JSON.parse(screen.getByTestId('slot-composer').textContent ?? 'null')).toMatchObject({ teammateId: ADA, model: MODEL_A, focus: true });
  });

  it('an existing chat never meets the gate', () => {
    const seam = { ...fakeSeam(), onEvent: () => () => {} };
    act(() => navStore.getState().openChat({ about: TASK, thread: '01a0-old' as EntityId }));
    render(<EntityChatSlot seam={seam as never} spaceId={SPACE} nodeKey="local" onOpenEntity={() => {}} subjectOf={() => ({ title: 'Task A', kind: 'task' })} />);
    expect(screen.getByTestId('slot-composer').textContent).toBe('null');
    expect(seam.chatDefaults).not.toHaveBeenCalled();
  });
});
