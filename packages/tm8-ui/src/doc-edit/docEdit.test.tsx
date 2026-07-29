// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import {
  CollabError,
  type ActorSummary,
  type CommandResult,
  type EntityCapabilities,
  type EntityCounters,
  type EntityDetail,
  type EntityId,
  type EntityState,
  type EntitySummary,
  type PatchEntityInput,
} from '@tm8/contract';
import {
  BlockEditorSlot,
  DocEditor,
  DocSplitView,
  EditEntryControl,
  blocksIn,
  useDocSave,
  type DocCommands,
} from './index';

/**
 * T5-3 DOC AUTHORING — the surface's own suite.
 *
 * WHAT THESE TESTS ARE FOR, and it is not pixels. jsdom cannot see layout, so
 * nothing here claims a measurement; the browser pass owns that (brief §4.4).
 * What it CAN see is whether every control the canvas draws EXISTS and is
 * either live through the real seam or disabled carrying an honest reason —
 * which is the bar this wave was given, and which is exactly the class of
 * defect ("I click run and nothing happens") that five dead verbs produced.
 *
 * The oracle is `T5-3 Doc Authoring Hi-Fi.dc.html`, three frames:
 *   F1 "Read and edit modes"            (lines 21-133)
 *   F2 "Z4 split view + block editors"  (lines 136-193)
 *   F3 "Save states, dark, 320 floor"   (lines 196-272)
 */

afterEach(cleanup);

const ada: ActorSummary = { id: 'm-ada', kind: 'member', displayName: 'ada', isAgent: false };

const COUNTERS: EntityCounters = {
  likes: 0, dislikes: 0, stars: 0, points: 0, messages: 6, viewerReaction: null,
};

const CAPS: EntityCapabilities = {
  canEdit: true, canDelete: false, canAddChild: true, canLink: true,
  canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
};

const STATE: EntityState = { kind: 'doc', format: 'markdown', childCount: 0 };

function docDetail(body: string, over: Partial<EntityDetail> = {}): EntityDetail {
  const base: EntitySummary = {
    id: 'doc-layout-spec',
    spaceId: 'sp-test',
    kind: 'doc',
    title: 'Layout spec',
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 3,
    activityAt: '2026-07-29T09:00:00.000Z',
    createdAt: '2026-07-28T09:00:00.000Z',
    updatedAt: '2026-07-29T09:00:00.000Z',
    deletedAt: null,
    createdBy: ada,
    counters: COUNTERS,
    state: STATE,
    badges: {},
  };
  return {
    ...base,
    content: { kind: 'doc', body, format: 'markdown' },
    hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
    connections: { outgoing: [], incoming: [], unresolvedHardDependencyCount: 0 },
    capabilities: CAPS,
    ...over,
  };
}

const OK: CommandResult = { patches: [] };

/**
 * A result that carries the version the write produced — which is what a real
 * one carries, and what the footer word is required to READ rather than
 * compute. `OK` above is the other real case: a result that says nothing about
 * the version, where the honest word is "saved" with no number.
 */
function savedAt(version: number): CommandResult {
  return { patches: [docDetail('', { version })] };
}

/** A scripted executor. `sent` is what the CALL actually carried. */
function scripted(behaviour?: (id: EntityId, input: PatchEntityInput) => Promise<CommandResult>) {
  const sent: Array<{ id: EntityId; input: PatchEntityInput }> = [];
  const commands: DocCommands = {
    patchEntity: (id, input) => {
      sent.push({ id, input });
      return behaviour ? behaviour(id, input) : Promise.resolve(OK);
    },
  };
  return { commands, sent };
}

/** The mount shape the handover documents. `detail` is swappable mid-draft. */
function Harness({
  body = '# Floors\n\nfloors are law.',
  commands,
  detail: given,
  onReload,
  editRefusal,
}: {
  body?: string;
  commands: DocCommands | null;
  detail?: EntityDetail;
  onReload?: (d: EntityDetail) => void;
  editRefusal?: string;
}) {
  const [detail, setDetail] = useState<EntityDetail>(given ?? docDetail(body));
  const save = useDocSave({
    detail,
    commands,
    editRefusal,
    onReload: (d) => {
      setDetail(d);
      onReload?.(d);
    },
  });
  return (
    <div className="cv2-root">
      <DocEditor save={save} detail={detail} />
      <button type="button" data-testid="bump" onClick={() => setDetail({ ...detail, version: detail.version + 4 })}>
        bump
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// F1 — the edit surface
// ---------------------------------------------------------------------------

describe('F1b — the edit surface exists and every control is reachable', () => {
  it('draws the Write/Preview toggle, Cancel, and a Save that names the version it will publish', () => {
    const { commands } = scripted();
    render(<Harness commands={commands} />);
    expect(screen.getByTestId('doc-stance-write')).toBeTruthy();
    expect(screen.getByTestId('doc-stance-preview')).toBeTruthy();
    expect(screen.getByTestId('doc-cancel')).toBeTruthy();
    // Oracle line 89: "Save v4" on a v3 doc — the NEXT version, not the current.
    expect(screen.getByTestId('doc-save').textContent).toContain('v4');
  });

  it('the draft survives the stance switch — the oracle annotation 2 promise', () => {
    const { commands } = scripted();
    render(<Harness commands={commands} />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'typed while writing' } });

    fireEvent.click(screen.getByTestId('doc-stance-preview'));
    expect(screen.queryByTestId('doc-source')).toBeNull();
    expect(screen.getByTestId('doc-preview').textContent).toContain('typed while writing');

    fireEvent.click(screen.getByTestId('doc-stance-write'));
    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('typed while writing');
  });

  it('preview renders the document, not the source: headings, quotes and prose are distinguished', () => {
    const { commands } = scripted();
    render(<Harness commands={commands} body={'## Floors\n\nfloors are law.\n\n> C_min = max(320, V·320)'} />);
    fireEvent.click(screen.getByTestId('doc-stance-preview'));
    expect(screen.getByTestId('doc-preview-heading').textContent).toBe('Floors');
    expect(screen.getByTestId('doc-preview-quote').textContent).toContain('C_min');
    expect(screen.getByTestId('doc-preview-prose').textContent).toContain('floors are law.');
  });
});

describe('F1a — the Edit entry is permission-honest (oracle annotation 1)', () => {
  function entry(props: Parameters<typeof EditEntryControl>[0]) {
    return render(
      <div className="cv2-root">
        <EditEntryControl {...props} />
      </div>,
    );
  }

  it('is a live control when the viewer may edit and a dispatch exists', () => {
    const onEnterEdit = vi.fn();
    entry({ detail: docDetail('x'), commands: scripted().commands, onEnterEdit });
    fireEvent.click(screen.getByTestId('doc-edit-entry'));
    expect(onEnterEdit).toHaveBeenCalledOnce();
  });

  it('renders DISABLED-WITH-REASON, never hidden, when the server refuses edits', () => {
    entry({
      detail: docDetail('x', { capabilities: { ...CAPS, canEdit: false } }),
      commands: scripted().commands,
      onEnterEdit: () => {},
      editRefusal: "your role can't edit docs in atelier",
    });
    // Never hidden — the whole point of annotation 1.
    expect(screen.getByTestId('disabled-with-reason')).toBeTruthy();
    expect(screen.getByText(/can't edit docs in atelier/)).toBeTruthy();
    expect(screen.queryByTestId('doc-edit-entry')).toBeNull();
  });

  it('renders disabled-with-reason when NO dispatch is wired — never live-and-inert', () => {
    entry({ detail: docDetail('x'), commands: scripted().commands });
    expect(screen.getByTestId('disabled-with-reason')).toBeTruthy();
    expect(screen.queryByTestId('doc-edit-entry')).toBeNull();
  });

  it('renders disabled-with-reason when no executor exists at all', () => {
    entry({ detail: docDetail('x'), commands: null, onEnterEdit: () => {} });
    expect(screen.getByTestId('disabled-with-reason')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The base-version law and the conflict it is designed to produce
// ---------------------------------------------------------------------------

describe('the save carries the version the edit was BASED ON, not the current one', () => {
  it('a version bump landing mid-draft does not change what the save sends', async () => {
    const { commands, sent } = scripted();
    render(<Harness commands={commands} />);

    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'my draft' } });
    // Someone else's write arrives as a fresh detail — v3 → v7.
    fireEvent.click(screen.getByTestId('bump'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });

    expect(sent).toHaveLength(1);
    /*
     * THE ASSERTION THE WHOLE SURFACE HANGS OFF. If this reads 7, the save
     * matches the version that just landed, the node accepts it, and the other
     * writer is overwritten with NO CONFLICT EVER FIRING — silently, and
     * invisibly to every test that does not move the version mid-draft.
     */
    expect(sent[0].input.expectedVersion).toBe(3);
    expect(sent[0].input.content).toEqual({ body: 'my draft' });
  });
});

describe('version conflict is a DESIGNED state — reload or overwrite, never silent', () => {
  function conflicting(current: EntityDetail | null, details?: Record<string, unknown>) {
    return scripted(() =>
      Promise.reject(
        new CollabError('version_conflict', 'expected version 3, have 4', {
          ...(current ? { current } : {}),
          ...(details ? { details } : {}),
        }),
      ),
    );
  }

  it('shows the banner the oracle draws — the fact, the consequence, and one quiet out', async () => {
    const theirs = docDetail('their text', { version: 4 });
    const { commands } = conflicting(theirs);
    render(<Harness commands={commands} />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'my draft' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });

    const banner = screen.getByTestId('doc-conflict-banner');
    // Oracle line 95-96: the fact, then what YOUR save will do.
    expect(banner.textContent).toContain('v4');
    expect(banner.textContent).toContain('v5');
    expect(screen.getByTestId('doc-load-theirs')).toBeTruthy();
    // No merge dialog, and no toast: the oracle's own law (line 208).
    expect(screen.queryByTestId('doc-merge')).toBeNull();
  });

  it('the draft survives the conflict — "your draft is still yours"', async () => {
    const { commands } = conflicting(docDetail('their text', { version: 4 }));
    render(<Harness commands={commands} />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'my draft' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });
    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('my draft');
  });

  it('overwrite re-sends at THEIR version, and says so', async () => {
    const sentAt: number[] = [];
    const theirs = docDetail('their text', { version: 4 });
    let first = true;
    const commands: DocCommands = {
      patchEntity: (_id, input) => {
        sentAt.push(input.expectedVersion);
        if (first) {
          first = false;
          return Promise.reject(new CollabError('version_conflict', 'stale', { current: theirs }));
        }
        return Promise.resolve(OK);
      },
    };
    render(<Harness commands={commands} />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'my draft' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-overwrite'));
    });
    expect(sentAt).toEqual([3, 4]);
  });

  it('OVERWRITE DISABLES WITH REASON when the node did not say which version won', async () => {
    const { commands } = conflicting(null);
    render(<Harness commands={commands} />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'my draft' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });
    // The move is VISIBLE and carries why it cannot run — never offered-and-failing.
    expect(screen.queryByTestId('doc-overwrite')).toBeNull();
    expect(screen.getByTestId('doc-conflict-banner').textContent).toMatch(/version is unknown|did not say/i);
    expect(screen.getAllByTestId('disabled-with-reason').length).toBeGreaterThan(0);
  });

  it('LOAD THEIRS DISABLES WITH REASON when the refusal carried no document — it never silently drops the draft', async () => {
    const { commands } = conflicting(null, { currentVersion: 4 });
    render(<Harness commands={commands} />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'my draft' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });
    /*
     * The version came through `details.currentVersion`, so OVERWRITE is live —
     * but no document came with it, so "load theirs" has nothing to load. It
     * says so rather than dropping the draft and showing nothing, which is what
     * a reload that fires with no payload would do.
     */
    expect(screen.getByTestId('doc-overwrite')).toBeTruthy();
    expect(screen.queryByTestId('doc-load-theirs')).toBeNull();
    expect(screen.getAllByTestId('disabled-with-reason').length).toBeGreaterThan(0);
  });

  it('load theirs hands the caller the served document and clears the draft', async () => {
    const theirs = docDetail('their text', { version: 4 });
    const { commands } = conflicting(theirs);
    const onReload = vi.fn();
    render(<Harness commands={commands} onReload={onReload} />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'my draft' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-load-theirs'));
    });
    expect(onReload).toHaveBeenCalledWith(theirs);
    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('their text');
  });
});

describe('a non-conflict refusal keeps the draft and states the server sentence', () => {
  it('renders the refusal with what did NOT happen', async () => {
    const { commands } = scripted(() =>
      Promise.reject(new CollabError('forbidden', 'the space is archived')),
    );
    render(<Harness commands={commands} />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'my draft' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });
    const card = screen.getByTestId('doc-refusal');
    expect(card.textContent).toContain('the space is archived');
    expect(card.textContent).toMatch(/Nothing was saved/i);
    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('my draft');
  });
});

// ---------------------------------------------------------------------------
// F3a — the four footer states, in WORDS
// ---------------------------------------------------------------------------

describe('F3a — the save word (word + colour, never colour alone)', () => {
  it('says "unsaved changes" once the draft is dirty', () => {
    const { commands } = scripted();
    render(<Harness commands={commands} />);
    expect(screen.getByTestId('doc-save-word').textContent).toMatch(/saved/);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'x' } });
    expect(screen.getByTestId('doc-save-word').textContent).toBe('unsaved changes');
  });

  it('says "saving…" while the request is out, and "saved · v4" when it lands', async () => {
    let release: (r: CommandResult) => void = () => {};
    const { commands } = scripted(() => new Promise<CommandResult>((res) => { release = res; }));
    render(<Harness commands={commands} />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });
    expect(screen.getByTestId('doc-save-word').textContent).toBe('saving…');
    await act(async () => {
      release(savedAt(4));
    });
    expect(screen.getByTestId('doc-save-word').textContent).toContain('saved');
    expect(screen.getByTestId('doc-save-word').textContent).toContain('v4');
  });

  it('names the other writer in the footer when a conflict is live (oracle line 207)', async () => {
    const { commands } = scripted(() =>
      Promise.reject(new CollabError('version_conflict', 'stale', { current: docDetail('t', { version: 4 }) })),
    );
    render(<Harness commands={commands} />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'x' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });
    expect(screen.getByTestId('doc-save-word').textContent).toMatch(/see banner/);
  });
});

describe('the surface refuses to pretend when it cannot save', () => {
  it('with no executor, Save is disabled-with-reason and the textarea is read-only', () => {
    render(<Harness commands={null} />);
    expect(screen.queryByTestId('doc-save')).toBeNull();
    expect(screen.getByTestId('disabled-with-reason')).toBeTruthy();
    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it('with canEdit false, the reason is the registry sentence the caller passed', () => {
    const { commands } = scripted();
    render(
      <Harness
        commands={commands}
        detail={docDetail('x', { capabilities: { ...CAPS, canEdit: false } })}
        editRefusal="your role can't edit docs in atelier"
      />,
    );
    expect(screen.getByText(/can't edit docs in atelier/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Blocks stay blocks (oracle annotation 3) — and the block editor is honest
// ---------------------------------------------------------------------------

describe('blocks', () => {
  const WITH_BLOCK = [
    '## Floors',
    '',
    '```mermaid breakpoint-cascade',
    'flowchart LR',
    '  rail --> center',
    '```',
    '',
    'The center hosts pinned panels.',
  ].join('\n');

  it('blocksIn finds a fenced diagram, its language and its name', () => {
    const blocks = blocksIn(WITH_BLOCK);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe('mermaid');
    expect(blocks[0].name).toBe('breakpoint-cascade');
    expect(blocks[0].source).toContain('flowchart LR');
  });

  it('a fence renders as a CHIP whose editor entry is disabled-with-reason, never as inline raw code', () => {
    const { commands } = scripted();
    render(<Harness commands={commands} body={WITH_BLOCK} />);
    const chip = screen.getByTestId('doc-block-chip');
    expect(chip.textContent).toContain('mermaid');
    expect(chip.textContent).toContain('breakpoint-cascade');
    // No renderer and no block editor exist — so the entry states that.
    expect(screen.getByTestId('disabled-with-reason')).toBeTruthy();
  });

  it('the preview shows the block as a placeholder that states it is not rendered', () => {
    const { commands } = scripted();
    render(<Harness commands={commands} body={WITH_BLOCK} />);
    fireEvent.click(screen.getByTestId('doc-stance-preview'));
    expect(screen.getByTestId('doc-preview-block').textContent).toMatch(/not rendered|no renderer/i);
  });

  it('F2b — the block editor slot exists and says why it cannot open', () => {
    render(
      <div className="cv2-root">
        <BlockEditorSlot block={blocksIn(WITH_BLOCK)[0]} />
      </div>,
    );
    expect(screen.getByTestId('doc-block-editor')).toBeTruthy();
    // Two dead verbs here, not one: "back to doc" and "Apply to draft". Both
    // are drawn and both carry a reason — which is the point of the assertion.
    expect(screen.getAllByTestId('disabled-with-reason').length).toBe(2);
    // "Apply to draft" is drawn (oracle line 176) and honest about being dead.
    expect(screen.getByText(/Apply to draft/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// F2a — the Z4 split
// ---------------------------------------------------------------------------

describe('F2a — the Z4 split view is the same editing session', () => {
  function SplitHarness({ commands }: { commands: DocCommands }) {
    const [detail, setDetail] = useState<EntityDetail>(docDetail('# Floors\n\nfloors are law.'));
    const save = useDocSave({ detail, commands, onReload: setDetail });
    return (
      <div className="cv2-root">
        <DocSplitView save={save} detail={detail} />
      </div>
    );
  }

  it('draws source and preview at once, both fed by the ONE draft', () => {
    const { commands } = scripted();
    render(<SplitHarness commands={commands} />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: '## Live\n\ntyped once' } });
    expect(screen.getByTestId('doc-preview').textContent).toContain('typed once');
    expect(screen.getByTestId('doc-preview-heading').textContent).toBe('Live');
  });

  it('carries the same Cancel/Save pair and the same save word', () => {
    const { commands } = scripted();
    render(<SplitHarness commands={commands} />);
    expect(screen.getByTestId('doc-save')).toBeTruthy();
    expect(screen.getByTestId('doc-cancel')).toBeTruthy();
    expect(screen.getByTestId('doc-save-word')).toBeTruthy();
  });

  it('the splitter is a real, keyboard-reachable separator', () => {
    const { commands } = scripted();
    render(<SplitHarness commands={commands} />);
    const bar = screen.getByTestId('doc-splitter');
    expect(bar.getAttribute('role')).toBe('separator');
    expect(bar.getAttribute('tabindex')).toBe('0');
    const before = bar.getAttribute('aria-valuenow');
    fireEvent.keyDown(bar, { key: 'ArrowLeft' });
    expect(bar.getAttribute('aria-valuenow')).not.toBe(before);
  });
});

describe('the footer advertises two shortcuts, so they have to work', () => {
  it('⌘enter saves', async () => {
    const { commands, sent } = scripted();
    render(<Harness commands={commands} />);
    const area = screen.getByTestId('doc-source');
    fireEvent.change(area, { target: { value: 'my draft' } });
    await act(async () => {
      fireEvent.keyDown(area, { key: 'Enter', metaKey: true });
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].input.content).toEqual({ body: 'my draft' });
  });

  it('ctrl+enter saves too — the same gesture on the other platform', async () => {
    const { commands, sent } = scripted();
    render(<Harness commands={commands} />);
    const area = screen.getByTestId('doc-source');
    fireEvent.change(area, { target: { value: 'my draft' } });
    await act(async () => {
      fireEvent.keyDown(area, { key: 'Enter', ctrlKey: true });
    });
    expect(sent).toHaveLength(1);
  });

  it('a bare enter types a newline and saves nothing', async () => {
    const { commands, sent } = scripted();
    render(<Harness commands={commands} />);
    const area = screen.getByTestId('doc-source');
    fireEvent.change(area, { target: { value: 'my draft' } });
    await act(async () => {
      fireEvent.keyDown(area, { key: 'Enter' });
    });
    expect(sent).toHaveLength(0);
  });

  it('esc cancels the draft, and does NOT escape the field to pop the panel underneath', () => {
    const { commands, sent } = scripted();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Harness commands={commands} body="served text" />
      </div>,
    );
    const area = screen.getByTestId('doc-source');
    fireEvent.change(area, { target: { value: 'my draft' } });
    fireEvent.keyDown(area, { key: 'Escape' });

    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('served text');
    expect(sent).toHaveLength(0);
    // C6 layer 4: Esc in a focused field belongs to the FIELD.
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('cancel drops the draft and sends nothing', () => {
  it('restores the served body', () => {
    const { commands, sent } = scripted();
    render(<Harness commands={commands} body="served text" />);
    fireEvent.change(screen.getByTestId('doc-source'), { target: { value: 'my draft' } });
    fireEvent.click(screen.getByTestId('doc-cancel'));
    expect((screen.getByTestId('doc-source') as HTMLTextAreaElement).value).toBe('served text');
    expect(sent).toHaveLength(0);
  });
});
