// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import type { ActorSummary, CommandResult, EntityDetail, PatchEntityInput } from '@tm8/contract';
import { ReaderSurface } from '../../panels/bodies/ReaderSurface';
import { AUTOSAVE_DELAY_MS } from '../index';
import { slashItems } from './RichBody';

const ada: ActorSummary = { id: 'm-ada', kind: 'member', displayName: 'ada', isAgent: false };

function docDetail(body: string): EntityDetail {
  return {
    id: 'doc-rich',
    spaceId: 'sp-test',
    kind: 'doc',
    title: 'Plan',
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 3,
    activityAt: '2026-10-07T09:00:00.000Z',
    createdAt: '2026-10-07T09:00:00.000Z',
    updatedAt: '2026-10-07T09:00:00.000Z',
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

function mount(body: string, skills = [{ id: 'sk-1', display: 'review', meta: 'Review a PR' }]) {
  const sent: PatchEntityInput[] = [];
  const patchEntity = vi.fn(async (_id: string, input: PatchEntityInput) => {
    sent.push(input);
    return { patches: [{ version: 4 }] } as unknown as CommandResult;
  });
  render(
    <ReaderSurface
      detail={docDetail(body)}
      blocks={[]}
      historyUnavailableReason=""
      commands={{ patchEntity } as never}
      skillOptions={skills}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /edit/i }));
  return { sent };
}

const field = () => screen.getByTestId('doc-rich');
const editorOf = () => (field() as unknown as { editor: Editor }).editor;
const typeText = (text: string) =>
  act(() => {
    editorOf().commands.insertContent(text);
  });

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

describe('the rich doc editor', () => {
  it('opens a markdown body in the rich editor, drawn with the reader typography', () => {
    mount('# Floors\n\nfloors are law');
    expect(field().className).toContain('md-root');
    expect(field().querySelector('h1')?.textContent).toBe('Floors');
  });

  it('opening and leaving untouched sends nothing: the stored spelling is not rewritten', async () => {
    vi.useFakeTimers();
    const { sent } = mount('* star list\n* two');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    });
    expect(sent).toHaveLength(0);
  });

  it('autosaves what is typed as markdown', async () => {
    vi.useFakeTimers();
    const { sent } = mount('first');
    act(() => {
      editorOf().commands.setContent('first\n\n**second**', { contentType: 'markdown', emitUpdate: true });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(sent).toHaveLength(1);
    expect((sent[0]!.content as { body: string }).body).toBe('first\n\n**second**');
    expect(sent[0]!.expectedVersion).toBe(3);
  });

  it('edits a body it cannot keep as markdown source, and says why', () => {
    mount('before\n\n<details>hidden</details>');
    expect(screen.queryByTestId('doc-rich')).toBeNull();
    expect(screen.getByTestId('doc-source')).toBeTruthy();
    expect(screen.getByTestId('doc-source-reason').textContent).toContain('raw HTML');
    expect(screen.queryByTestId('doc-mode-rich')).toBeNull();
  });

  it('switches to markdown source and back', () => {
    mount('plain words');
    fireEvent.click(screen.getByTestId('doc-mode-source'));
    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('plain words');
    fireEvent.click(screen.getByTestId('doc-mode-rich'));
    expect(field().textContent).toBe('plain words');
  });

  it("'/' offers blocks, and Enter turns the line into the picked one", () => {
    mount('');
    act(() => {
      editorOf().commands.focus();
    });
    typeText('/head');
    const items = screen.getAllByTestId('doc-slash-item').map((item) => item.textContent);
    expect(items).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.queryByTestId('doc-slash-menu')).toBeNull();
    expect(editorOf().isActive('heading', { level: 2 })).toBe(true);
    expect(editorOf().getText().trim()).toBe('');
  });

  it("'/' offers skills in the same menu, and picking one writes a skill link", () => {
    mount('');
    act(() => {
      editorOf().commands.focus();
    });
    typeText('ask /rev');
    expect(screen.getAllByTestId('doc-slash-item').map((item) => item.textContent)).toEqual(['/reviewReview a PR']);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(editorOf().getMarkdown()).toBe('ask [/review](tm8://skill/sk-1) ');
  });

  it("'/' inside a word or a code block is just a character", () => {
    mount('');
    act(() => {
      editorOf().commands.focus();
    });
    typeText('and/or');
    expect(screen.queryByTestId('doc-slash-menu')).toBeNull();
  });

  it('Esc closes the menu and leaves the text', () => {
    mount('');
    act(() => {
      editorOf().commands.focus();
    });
    typeText('/');
    expect(screen.getByTestId('doc-slash-menu')).toBeTruthy();
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByTestId('doc-slash-menu')).toBeNull();
    expect(editorOf().getText()).toBe('/');
  });
});

describe('slashItems', () => {
  it('filters blocks by name and skills by prefix', () => {
    expect(slashItems('tab').map((item) => item.label)).toEqual(['Table']);
    expect(slashItems('', [{ id: 's', display: 'deploy' }]).at(-1)?.label).toBe('/deploy');
  });
});
