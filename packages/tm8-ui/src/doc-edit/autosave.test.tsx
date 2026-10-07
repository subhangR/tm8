// @vitest-environment jsdom
/**
 * NEW DOC UX (2026-10-06) — autosave, the device copy, the title in the
 * editor, and a fresh doc's arrival, asserted through `ReaderSurface`, the one
 * host that turns autosave on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  CollabError,
  type ActorSummary,
  type CommandResult,
  type EntityDetail,
  type PatchEntityInput,
} from '@tm8/contract';
import { ReaderSurface } from '../panels/bodies/ReaderSurface';
import { AUTOSAVE_DELAY_MS, forgetFreshDoc, markFreshDoc, readLocalDraft, useLiveTitle } from './index';

const ada: ActorSummary = { id: 'm-ada', kind: 'member', displayName: 'ada', isAgent: false };
const DOC_ID = 'doc-autosave';

function docDetail(body = 'first line', version = 3, title = 'Plan'): EntityDetail {
  return {
    id: DOC_ID,
    spaceId: 'sp-test',
    kind: 'doc',
    title,
    parentId: null,
    position: 0,
    visibility: 'space',
    version,
    activityAt: '2026-10-06T09:00:00.000Z',
    createdAt: '2026-10-06T09:00:00.000Z',
    updatedAt: '2026-10-06T09:00:00.000Z',
    deletedAt: null,
    createdBy: ada,
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind: 'doc', format: 'markdown', childCount: 0 },
    badges: {},
    content: { kind: 'doc', body, format: 'markdown' },
    hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
    connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
    capabilities: {
      canEdit: true, canDelete: true, canAddChild: true, canLink: true,
      canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
    },
  } as EntityDetail;
}

const saved = (version: number) => ({ patches: [{ version }] }) as unknown as CommandResult;

/** A `patchEntity` whose answers the test hands out one at a time. */
function scriptedCommands() {
  const sent: PatchEntityInput[] = [];
  const answers: Array<{ resolve(r: CommandResult): void; reject(e: unknown): void }> = [];
  const patchEntity = vi.fn(
    (_id: string, input: PatchEntityInput) =>
      new Promise<CommandResult>((resolve, reject) => {
        sent.push(input);
        answers.push({ resolve, reject });
      }),
  );
  return { commands: { patchEntity } as never, sent, answers };
}

function mount(commands: never, detail = docDetail()) {
  return render(<ReaderSurface detail={detail} blocks={[]} historyUnavailableReason="" commands={commands} />);
}

const enterEdit = () => fireEvent.click(screen.getByRole('button', { name: /edit/i }));
const typeBody = (value: string) => fireEvent.change(screen.getByTestId('doc-source'), { target: { value } });
const pause = (ms = AUTOSAVE_DELAY_MS) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const settle = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  forgetFreshDoc(DOC_ID);
});

describe('autosave', () => {
  it('saves a pause after the last keystroke, at the version the edit was based on', async () => {
    const { commands, sent } = scriptedCommands();
    mount(commands);
    enterEdit();

    typeBody('first line, edited');
    await pause(AUTOSAVE_DELAY_MS - 1);
    expect(sent).toHaveLength(0);
    await pause(1);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.expectedVersion).toBe(3);
    expect((sent[0]!.content as { body: string }).body).toBe('first line, edited');
  });

  it('keeps keystrokes typed while a save is in flight and sends them on the version just written', async () => {
    const { commands, sent, answers } = scriptedCommands();
    mount(commands);
    enterEdit();

    typeBody('a');
    await pause();
    expect(sent).toHaveLength(1);
    typeBody('ab');
    await act(async () => answers[0]!.resolve(saved(4)));
    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('ab');

    await pause();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.expectedVersion).toBe(4);
    expect((sent[1]!.content as { body: string }).body).toBe('ab');
  });

  it('shows what it saved, not the older served text, until the detail catches up', async () => {
    const { commands, answers } = scriptedCommands();
    mount(commands);
    enterEdit();

    typeBody('saved text');
    await pause();
    await act(async () => answers[0]!.resolve(saved(4)));

    expect(screen.getByTestId('doc-save-word').textContent).toContain('Saved · v4');
    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('saved text');
  });

  it('parks on a conflict: typing on keeps the draft and sends nothing until the banner is answered', async () => {
    const { commands, sent, answers } = scriptedCommands();
    mount(commands);
    enterEdit();

    typeBody('mine');
    await pause();
    await act(async () =>
      answers[0]!.reject(new CollabError('version_conflict', 'stale', { current: docDetail('theirs', 4) })),
    );
    typeBody('mine, more');
    await pause(AUTOSAVE_DELAY_MS * 3);

    expect(sent).toHaveLength(1);
    expect(screen.getByTestId('doc-save-word').textContent).toContain('Conflict');
    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('mine, more');
  });

  it('Esc throws nothing away', () => {
    const { commands } = scriptedCommands();
    mount(commands);
    enterEdit();

    typeBody('kept');
    fireEvent.keyDown(screen.getByTestId('doc-source'), { key: 'Escape' });

    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('kept');
    expect(screen.queryByTestId('doc-cancel')).toBeNull();
  });
});

describe('the device copy', () => {
  it('mirrors every edit with its base version, and drops it once the save lands', async () => {
    const { commands, answers } = scriptedCommands();
    mount(commands);
    enterEdit();

    typeBody('on this device');
    expect(readLocalDraft(DOC_ID)).toEqual({ edits: { body: 'on this device' }, baseVersion: 3 });

    await pause();
    await act(async () => answers[0]!.resolve(saved(4)));
    expect(readLocalDraft(DOC_ID)).toBeNull();
  });

  it('restores an unsent draft when the doc opens again, and saves it against its own base', async () => {
    const first = scriptedCommands();
    const view = mount(first.commands);
    enterEdit();
    typeBody('typed before the reload');
    view.unmount();

    const second = scriptedCommands();
    mount(second.commands);
    await settle();
    await pause();

    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.expectedVersion).toBe(3);
    expect((second.sent[0]!.content as { body: string }).body).toBe('typed before the reload');
  });
});

describe('the title, written in the editor', () => {
  it('rides the same patch as the body', async () => {
    const { commands, sent } = scriptedCommands();
    mount(commands);
    enterEdit();

    fireEvent.change(screen.getByTestId('doc-title'), { target: { value: 'Launch plan' } });
    typeBody('first line, edited');
    await pause();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe('Launch plan');
    expect((sent[0]!.content as { body: string }).body).toBe('first line, edited');
  });

  it('saves "Untitled" for a cleared title, never an empty one', async () => {
    const { commands, sent } = scriptedCommands();
    mount(commands);
    enterEdit();

    fireEvent.change(screen.getByTestId('doc-title'), { target: { value: '   ' } });
    await pause();

    expect(sent[0]!.title).toBe('Untitled');
  });

  it('Enter in the title moves the caret to the body', () => {
    const { commands } = scriptedCommands();
    mount(commands);
    enterEdit();

    fireEvent.keyDown(screen.getByTestId('doc-title'), { key: 'Enter' });
    expect(document.activeElement).toBe(screen.getByTestId('doc-source'));
  });

  it("is written in the host's title band when there is one, once, and Enter still reaches the body", () => {
    const { commands } = scriptedCommands();
    const band = document.body.appendChild(document.createElement('div'));
    render(
      <ReaderSurface detail={docDetail()} blocks={[]} historyUnavailableReason="" commands={commands} titleSlot={band} />,
    );
    enterEdit();

    expect(screen.getAllByTestId('doc-title')).toHaveLength(1);
    expect(band.contains(screen.getByTestId('doc-title'))).toBe(true);
    fireEvent.keyDown(screen.getByTestId('doc-title'), { key: 'Enter' });
    expect(document.activeElement).toBe(screen.getByTestId('doc-source'));
    band.remove();
  });

  it('the tab follows the title as it is typed, and hands back to the saved title once it lands', async () => {
    const { commands, answers } = scriptedCommands();
    function TabLabel() {
      return <span data-testid="tab-label">{useLiveTitle(DOC_ID) ?? 'saved title'}</span>;
    }
    render(<TabLabel />);
    mount(commands);
    enterEdit();

    fireEvent.change(screen.getByTestId('doc-title'), { target: { value: 'Launch plan' } });
    expect(screen.getByTestId('tab-label').textContent).toBe('Launch plan');

    await pause();
    await act(async () => answers[0]!.resolve(saved(4)));
    await settle();
    expect(screen.getByTestId('tab-label').textContent).toBe('saved title');
  });
});

describe('a doc New doc just made', () => {
  it('opens in the editor with the caret in the title — once', () => {
    const { commands } = scriptedCommands();
    markFreshDoc(DOC_ID);
    const view = mount(commands, docDetail('', 1, 'Untitled'));

    expect(screen.getByTestId('reader-surface').getAttribute('data-stance')).toBe('edit');
    const title = screen.getByTestId('doc-title') as HTMLInputElement;
    expect(document.activeElement).toBe(title);
    expect(title.value).toBe('');
    expect(title.placeholder).toBe('Untitled');

    view.unmount();
    mount(commands, docDetail('', 1, 'Untitled'));
    expect(screen.getByTestId('reader-surface').getAttribute('data-stance')).toBe('read');
  });
});
