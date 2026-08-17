// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CollabError, WorkStatusSchema } from '@tm8/contract';
import type { CommandResult, EntityDetail, EntityKind, PatchTaskInput } from '@tm8/contract';
import { fixtureDetails, taskUuidTitle } from '../fixtures';
import {
  AuthoringHost,
  InlineTitleEditor,
  NewTaskControl,
  RefusalCard,
  SaveControls,
  StatusSelect,
  classifyFailure,
  createdIdOf,
  nextMutationId,
  placeholderTitleFor,
  useNewTask,
  useTaskSave,
  type AuthoringCommands,
} from './index';

/**
 * THE AUTHORING FLOWS — new-task creation and the save path.
 *
 * Written against the ABSENT state first (the directory did not exist and the
 * run died at import), and the load-bearing assertions were re-reddened
 * against a deliberately broken implementation. The captured output of both
 * reds is in HANDOVER-Authoring.md: a green that was never red is a claim, not
 * a measurement.
 *
 * NOTE ON MATCHERS: this package does NOT install @testing-library/jest-dom.
 * `toHaveTextContent` / `toBeInTheDocument` would pass vacuously or throw, so
 * every assertion below reads `.textContent` / `.getAttribute()` directly, as
 * `panels.test.tsx` does. And `cleanup` runs between tests because the runner
 * has no global setup file — without it `screen` queries the leftovers of the
 * previous render and a stale node satisfies the new assertion.
 */

afterEach(cleanup);

// `fixtureDetails` is a Record keyed by id, not an array — checked in the
// tree rather than assumed from the name.
const TASK = fixtureDetails[taskUuidTitle.id] as EntityDetail;

function taskAt(version: number, over: Partial<EntityDetail> = {}): EntityDetail {
  return { ...TASK, version, ...over };
}

/** A scripted executor that records ARGUMENTS, so the assertions can be about
 *  what was sent rather than about the fact that something was called. */
function scriptCommands(script: {
  createEntity?: (n: number) => Promise<CommandResult>;
  patchTask?: (n: number, input: PatchTaskInput) => Promise<CommandResult>;
}) {
  const calls: { create: Record<string, unknown>[]; patch: { id: string; input: PatchTaskInput }[] } = {
    create: [],
    patch: [],
  };
  const commands: AuthoringCommands = {
    async createEntity(input) {
      calls.create.push(input as unknown as Record<string, unknown>);
      return script.createEntity
        ? script.createEntity(calls.create.length)
        : ({ entity: taskAt(1), patches: [taskAt(1)] } as CommandResult);
    },
    async patchTask(id, input) {
      calls.patch.push({ id: String(id), input });
      return script.patchTask
        ? script.patchTask(calls.patch.length, input)
        : ({ entity: taskAt(input.expectedVersion + 1), patches: [] } as CommandResult);
    },
  };
  return { commands, calls };
}

function conflictAt(current: number): CollabError {
  return new CollabError('version_conflict', `expected version 3, have ${current}`, {
    current: taskAt(current, { title: 'renamed by someone else' }),
  });
}

// ---------------------------------------------------------------------------
// commands.ts — the port and its failure vocabulary
// ---------------------------------------------------------------------------

describe('the authoring port', () => {
  it('mints a distinct clientMutationId per call', () => {
    const a = nextMutationId();
    const b = nextMutationId();
    expect(a).not.toEqual(b);
    expect(a.startsWith('au-')).toBe(true);
  });

  it('reads the new id out of a CommandResult, and reports honestly when there is none', () => {
    expect(createdIdOf({ entity: taskAt(1), patches: [] } as CommandResult)).toEqual(TASK.id);
    // `entity` is OPTIONAL on CommandResult; `patches` is the fallback source.
    expect(createdIdOf({ patches: [taskAt(1)] } as CommandResult)).toEqual(TASK.id);
    // Neither present ⇒ null. Never an invented id, never a crash.
    expect(createdIdOf({ patches: [] } as CommandResult)).toBeNull();
  });

  it('classifies a version_conflict as its own kind, carrying the server detail', () => {
    const failure = classifyFailure(conflictAt(4), 'save');
    expect(failure.kind).toBe('conflict');
    if (failure.kind !== 'conflict') throw new Error('unreachable');
    expect(failure.currentVersion).toBe(4);
    expect(failure.current?.title).toBe('renamed by someone else');
  });

  it('reads currentVersion from error.details when no full detail arrives', () => {
    // The contract admits `details.currentVersion` (ErrorDetails) as well as
    // `current: EntityDetail`. A real node may send only the number.
    const failure = classifyFailure(
      new CollabError('version_conflict', 'stale', { details: { reason: 'stale', currentVersion: 9 } }),
      'save',
    );
    if (failure.kind !== 'conflict') throw new Error('expected a conflict');
    expect(failure.currentVersion).toBe(9);
    expect(failure.current).toBeNull();
  });

  it('classifies a forbidden as refused and keeps the contract retryable flag', () => {
    const failure = classifyFailure(new CollabError('forbidden', 'nope'), 'save');
    expect(failure.kind).toBe('refused');
    if (failure.kind !== 'refused') throw new Error('unreachable');
    expect(failure.retryable).toBe(false);
    expect(failure.code).toBe('forbidden');
  });

  it('does not pretend a non-CollabError is a typed refusal', () => {
    const failure = classifyFailure(new TypeError('fetch exploded'), 'save');
    if (failure.kind !== 'refused') throw new Error('unreachable');
    expect(failure.code).toBe('unknown');
    expect(failure.detail).toContain('fetch exploded');
  });
});

// ---------------------------------------------------------------------------
// The create flow
// ---------------------------------------------------------------------------

function NewTaskHarness({
  commands,
  onCreated,
  kind = 'task',
  label = 'Task',
}: {
  commands: AuthoringCommands | null;
  onCreated?: (id: string) => void;
  kind?: EntityKind;
  label?: string;
}) {
  const flow = useNewTask({
    spaceId: TASK.spaceId,
    kind,
    placeholderTitle: placeholderTitleFor(label),
    commands,
    onCreated: (id) => onCreated?.(String(id)),
  });
  return <NewTaskControl flow={flow} label="+ New" />;
}

describe('the new-task flow', () => {
  it('renders the oracle placeholder from registry data, never a kind literal', () => {
    // T5-6 draws the row as "Untitled task"; the word comes from the kind's
    // own `label`, so a new kind needs no edit here.
    expect(placeholderTitleFor('Task')).toBe('Untitled task');
    expect(placeholderTitleFor('Doc')).toBe('Untitled doc');
  });

  it('creates FOR REAL on the first press, with a clientMutationId', async () => {
    const { commands, calls } = scriptCommands({});
    const created = vi.fn();
    render(<NewTaskHarness commands={commands} onCreated={created} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /new/i }));
    });
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].title).toBe('Untitled task');
    expect(calls.create[0].spaceId).toBe(TASK.spaceId);
    expect(typeof calls.create[0].clientMutationId).toBe('string');
    expect(created).toHaveBeenCalledWith(TASK.id);
  });

  /**
   * THE DEFECT THIS FILE MISSED. Every surface got its create from this hook,
   * and the hook called `createTask` — which the ops layer sends as
   * `kind: 'task'`. So "＋ New channel" on the channels list created a task,
   * the channel list never showed it, and the user saw NOTHING HAPPEN.
   *
   * The old assertions could not catch it: this harness only ever stood on a
   * task, so the kind it sent was accidentally right and the wrongness was
   * invisible. The parameter is the fix and the second case is the proof.
   */
  it('creates the KIND OF THE LIST IT IS IN, not always a task', async () => {
    const { commands, calls } = scriptCommands({});
    render(<NewTaskHarness commands={commands} kind="channel" label="Channel" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /new/i }));
    });
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].kind).toBe('channel');
    expect(calls.create[0].title).toBe('Untitled channel');
  });

  it('DISABLES WITH REASON on a kind the generic create cannot make', () => {
    // `work_session` is born from a spawn, never from `entities.create` — the
    // contract's own schema says so. Before, this control silently made a task.
    const { commands, calls } = scriptCommands({});
    render(<NewTaskHarness commands={commands} kind="work_session" label="Session" />);
    expect(document.querySelector('button')).toBeNull();
    expect(screen.getByTestId('disabled-with-reason').getAttribute('aria-disabled')).toBe('true');
    expect(calls.create).toHaveLength(0);
  });

  it('shows the promise while it is in flight and refuses a second press', async () => {
    let release!: (r: CommandResult) => void;
    const { commands, calls } = scriptCommands({
      createEntity: () => new Promise<CommandResult>((resolve) => { release = resolve; }),
    });
    render(<NewTaskHarness commands={commands} />);
    const button = screen.getByRole('button', { name: /new/i });
    await act(async () => { fireEvent.click(button); });

    // PENDING SHOWS ITS PROMISE — not a dead control and not a silent one.
    expect(screen.getByTestId('authoring-pending').textContent).toMatch(/creating/i);
    expect(button.getAttribute('aria-busy')).toBe('true');

    await act(async () => { fireEvent.click(button); });
    expect(calls.create, 'a second press must not create a second task').toHaveLength(1);

    await act(async () => { release({ entity: taskAt(1), patches: [] } as CommandResult); });
    expect(screen.queryByTestId('authoring-pending')).toBeNull();
  });

  it('renders a refusal in the designed card and creates nothing', async () => {
    const { commands } = scriptCommands({
      createEntity: () => Promise.reject(new CollabError('forbidden', 'read-only space')),
    });
    const created = vi.fn();
    render(<NewTaskHarness commands={commands} onCreated={created} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /new/i })); });
    const card = screen.getByTestId('authoring-refusal');
    expect(card.textContent).toMatch(/create refused/i);
    // T5-5's refusal grammar: the card states WHAT DID NOT HAPPEN.
    expect(card.textContent).toMatch(/nothing was created/i);
    expect(created).not.toHaveBeenCalled();
  });

  it('states honestly when a create returned no id rather than inventing one', async () => {
    const { commands } = scriptCommands({
      createEntity: async () => ({ patches: [] }) as CommandResult,
    });
    const created = vi.fn();
    render(<NewTaskHarness commands={commands} onCreated={created} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /new/i })); });
    expect(created).not.toHaveBeenCalled();
    expect(screen.getByTestId('authoring-refusal').textContent).toMatch(/did not return/i);
  });

  it('DISABLES WITH REASON when no executor was injected (R7), never inert', () => {
    render(<NewTaskHarness commands={null} />);
    /**
     * Asserted on the ELEMENT, not on the role. `DisabledAction` renders a
     * span carrying `role="button"` + `aria-label` (D28 — a natively disabled
     * control leaves the tab order and takes its reason with it), so
     * `queryByRole('button', …)` MATCHES IT and an assertion written that way
     * would have been satisfied by the very thing it was meant to forbid.
     * Caught while writing this file; recorded because it is the same shape as
     * the "counts survive" test that stood over a dropped count (D31).
     */
    expect(document.querySelector('button')).toBeNull();
    const disabled = screen.getByTestId('disabled-with-reason');
    expect(disabled.tagName).toBe('SPAN');
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    // D28: reachable, so the reason can actually be learned.
    expect(disabled.getAttribute('tabindex')).toBe('0');
    expect(document.body.textContent).toContain('not wired');
  });
});

// ---------------------------------------------------------------------------
// The save flow
// ---------------------------------------------------------------------------

function SaveHarness({
  detail,
  commands,
  onReload,
}: {
  detail: EntityDetail;
  commands: AuthoringCommands | null;
  onReload?: (d: EntityDetail) => void;
}) {
  const save = useTaskSave({ detail, commands, onReload });
  return (
    <AuthoringHost save={save}>
      <InlineTitleEditor
        value={detail.title}
        editable={detail.capabilities.canEdit && detail.deletedAt === null}
        onCommit={(title) => void save.commitNow({ title })}
      />
      <SaveControls save={save} />
      <button type="button" onClick={() => save.edit({ description: 'staged' })}>
        stage a field
      </button>
    </AuthoringHost>
  );
}

function openTitleEditor(): HTMLInputElement {
  fireEvent.click(screen.getByTestId('authoring-title'));
  return screen.getByRole('textbox', { name: /title/i }) as HTMLInputElement;
}

describe('the inline title', () => {
  it('marks an editable title as interactive and states a lock', () => {
    const { rerender } = render(
      <InlineTitleEditor value="Session tree guide lines" editable onCommit={() => {}} />,
    );
    expect(screen.getByTestId('authoring-title').className).toContain('au-title--editable');

    rerender(
      <InlineTitleEditor
        value="feat: something"
        editable={false}
        lockedReason="tracked from GitHub — the title follows the source"
        onCommit={() => {}}
      />,
    );
    const locked = screen.getByTestId('authoring-title');
    expect(locked.className).not.toContain('au-title--editable');
    // A LOCK IS STATED, not merely absent (T0-4: "tracked kinds lock it").
    expect(locked.getAttribute('title')).toContain('tracked from GitHub');
    fireEvent.click(locked);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('Enter commits and Esc keeps the placeholder — the oracle sentence, verbatim', async () => {
    const { commands, calls } = scriptCommands({});
    render(<SaveHarness detail={taskAt(3)} commands={commands} />);

    let input = openTitleEditor();
    fireEvent.change(input, { target: { value: 'Real name' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(calls.patch).toHaveLength(1);
    expect(calls.patch[0].input.title).toBe('Real name');

    input = openTitleEditor();
    fireEvent.change(input, { target: { value: 'discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(calls.patch, 'Esc sends no command at all').toHaveLength(1);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('sends no command when the title did not actually change', async () => {
    const { commands, calls } = scriptCommands({});
    render(<SaveHarness detail={taskAt(3)} commands={commands} />);
    const input = openTitleEditor();
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(calls.patch).toHaveLength(0);
  });
});

describe('the save flow', () => {
  it('sends expectedVersion — and it is the version the EDIT was made against', async () => {
    /**
     * THE LOAD-BEARING ASSERTION. If the hook read `detail.version` at SAVE
     * time rather than at EDIT time, a concurrent write landing mid-edit would
     * make our patch match the NEW version and overwrite the other writer
     * silently — the exact defect expectedVersion exists to prevent. No
     * conflict would ever fire, so nothing else in this file would go red.
     */
    const { commands, calls } = scriptCommands({});
    const { rerender } = render(<SaveHarness detail={taskAt(3)} commands={commands} />);
    fireEvent.click(screen.getByRole('button', { name: /stage a field/i }));
    // Someone else's write lands while the draft is open.
    rerender(<SaveHarness detail={taskAt(7)} commands={commands} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^save$/i })); });
    expect(calls.patch[0].input.expectedVersion).toBe(3);
  });

  it('flushes the whole dirty set in ONE patch, so two fields cannot race', async () => {
    const { commands, calls } = scriptCommands({});
    render(<SaveHarness detail={taskAt(3)} commands={commands} />);
    fireEvent.click(screen.getByRole('button', { name: /stage a field/i }));
    const input = openTitleEditor();
    fireEvent.change(input, { target: { value: 'both' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(calls.patch).toHaveLength(1);
    expect(calls.patch[0].input.description).toBe('staged');
    expect(calls.patch[0].input.title).toBe('both');
  });

  it('shows the editing pill while dirty and clears it when clean', async () => {
    const { commands } = scriptCommands({});
    render(<SaveHarness detail={taskAt(3)} commands={commands} />);
    expect(screen.queryByTestId('authoring-editing-pill')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /stage a field/i }));
    expect(screen.getByTestId('authoring-editing-pill').textContent).toBe('editing');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^save$/i })); });
    expect(screen.queryByTestId('authoring-editing-pill')).toBeNull();
  });

  it('Cancel drops the draft without sending anything', () => {
    const { commands, calls } = scriptCommands({});
    render(<SaveHarness detail={taskAt(3)} commands={commands} />);
    fireEvent.click(screen.getByRole('button', { name: /stage a field/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(calls.patch).toHaveLength(0);
    expect(screen.queryByTestId('authoring-editing-pill')).toBeNull();
  });

  it('renders SAVING as its own state — the promise is shown, not hidden', async () => {
    let release!: (r: CommandResult) => void;
    const { commands } = scriptCommands({
      patchTask: () => new Promise<CommandResult>((r) => { release = r; }),
    });
    render(<SaveHarness detail={taskAt(3)} commands={commands} />);
    fireEvent.click(screen.getByRole('button', { name: /stage a field/i }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^save$/i })); });
    const saving = screen.getByTestId('authoring-save');
    expect(saving.getAttribute('aria-busy')).toBe('true');
    expect(saving.textContent).toMatch(/saving/i);
    await act(async () => { release({ patches: [] } as CommandResult); });
    expect(screen.queryByTestId('authoring-editing-pill')).toBeNull();
  });

  it('DISABLES WITH REASON when there is no executor', () => {
    render(<SaveHarness detail={taskAt(3)} commands={null} />);
    fireEvent.click(screen.getByRole('button', { name: /stage a field/i }));
    const disabled = screen.getByTestId('disabled-with-reason');
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    // No REAL save button exists — see the note in the create-flow test above
    // on why this is asserted on the element rather than on the role.
    expect(document.querySelector('.au-btn--primary')).toBeNull();
    expect(screen.queryByTestId('authoring-editing-pill')).toBeNull();
  });

  it('DISABLES WITH REASON when the server says canEdit is false', () => {
    const locked = taskAt(3, { capabilities: { ...TASK.capabilities, canEdit: false } });
    const { commands } = scriptCommands({});
    render(<SaveHarness detail={locked} commands={commands} />);
    // The title is not editable either — the same server truth, one source.
    fireEvent.click(screen.getByTestId('authoring-title'));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The version conflict — a DESIGNED state, never a silent overwrite
// ---------------------------------------------------------------------------

describe('a version conflict', () => {
  async function intoConflict(current = 8) {
    const { commands, calls } = scriptCommands({
      patchTask: (n) =>
        n === 1
          ? Promise.reject(conflictAt(current))
          : Promise.resolve({ patches: [] } as CommandResult),
    });
    const onReload = vi.fn();
    render(<SaveHarness detail={taskAt(3)} commands={commands} onReload={onReload} />);
    fireEvent.click(screen.getByRole('button', { name: /stage a field/i }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^save$/i })); });
    return { calls, onReload };
  }

  it('renders the conflict card with BOTH versions named, and keeps the draft', async () => {
    await intoConflict(8);
    const card = screen.getByTestId('authoring-conflict');
    expect(card.textContent).toMatch(/changed/i);
    expect(card.textContent).toContain('v3');
    expect(card.textContent).toContain('v8');
    // T5-5's refusal grammar: what did NOT happen, and where your work is.
    expect(card.textContent).toMatch(/nothing was saved/i);
    expect(screen.queryByTestId('authoring-editing-pill')).not.toBeNull();
  });

  it('offers reload-or-overwrite and does NEITHER on its own', async () => {
    const { calls } = await intoConflict(8);
    expect(calls.patch, 'the hook must not retry by itself').toHaveLength(1);
    expect(screen.queryByRole('button', { name: /reload/i })).not.toBeNull();
    expect(screen.queryByRole('button', { name: /overwrite/i })).not.toBeNull();
  });

  it('reload takes THEIRS: the draft is dropped and the server detail handed back', async () => {
    const { calls, onReload } = await intoConflict(8);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /reload/i })); });
    expect(onReload).toHaveBeenCalledWith(
      expect.objectContaining({ version: 8, title: 'renamed by someone else' }),
    );
    expect(calls.patch).toHaveLength(1);
    expect(screen.queryByTestId('authoring-conflict')).toBeNull();
    expect(screen.queryByTestId('authoring-editing-pill')).toBeNull();
  });

  it('overwrite keeps MINE — explicitly, at THEIR version', async () => {
    const { calls } = await intoConflict(8);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /overwrite/i })); });
    expect(calls.patch).toHaveLength(2);
    expect(calls.patch[1].input.expectedVersion).toBe(8);
    expect(calls.patch[1].input.description).toBe('staged');
  });

  it('cannot offer overwrite when the node did not say which version won', async () => {
    // No `current` and no `details.currentVersion` — we do not know what we
    // would be overwriting, so offering the button would be a guess wearing a
    // verb. It renders disabled-with-reason instead of vanishing.
    const { commands } = scriptCommands({
      patchTask: () => Promise.reject(new CollabError('version_conflict', 'stale')),
    });
    render(<SaveHarness detail={taskAt(3)} commands={commands} />);
    fireEvent.click(screen.getByRole('button', { name: /stage a field/i }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^save$/i })); });
    // Exactly one overwrite affordance, and it is the disabled span — not
    // hidden (the user learns the move exists) and not clickable.
    const overwrites = screen.getAllByRole('button', { name: /overwrite/i });
    expect(overwrites).toHaveLength(1);
    expect(overwrites[0].getAttribute('aria-disabled')).toBe('true');
    expect(document.querySelector('.au-refusal__move')?.textContent).toMatch(/reload/i);
    // The reason lives in DisabledAction's SIBLING caption, not inside the
    // control span — asserted where it actually renders, because a reason the
    // user cannot read is the failure this treatment exists to prevent.
    expect(document.body.textContent).toMatch(/current version is unknown/i);
  });
});

// ---------------------------------------------------------------------------
// Status, and the shared refusal card
// ---------------------------------------------------------------------------

describe('inline status', () => {
  const OPTIONS = [
    { value: 'open' as const, label: 'open', tone: 'idle' as const },
    { value: 'working' as const, label: 'working', tone: 'run' as const },
    { value: 'done' as const, label: 'done', tone: 'run' as const },
  ];

  it('offers only contract WorkStatus values', () => {
    for (const option of OPTIONS) expect(WorkStatusSchema.options).toContain(option.value);
  });

  it('patches the status through the same one builder the title uses', async () => {
    const { commands, calls } = scriptCommands({});
    function Harness() {
      const save = useTaskSave({ detail: taskAt(5), commands });
      return (
        <AuthoringHost save={save}>
          <StatusSelect
            value="open"
            options={OPTIONS}
            editable
            onSelect={(workStatus) => void save.commitNow({ workStatus })}
          />
        </AuthoringHost>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByTestId('authoring-status'));
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'working' })); });
    expect(calls.patch).toHaveLength(1);
    expect(calls.patch[0].input.workStatus).toBe('working');
    expect(calls.patch[0].input.expectedVersion).toBe(5);
  });

  it('renders a locked status as a plain pill with no picker', () => {
    render(<StatusSelect value="open" options={OPTIONS} editable={false} onSelect={() => {}} />);
    fireEvent.click(screen.getByTestId('authoring-status'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('the designed refusal card', () => {
  it('carries the T5-5 grammar: red word, cause, what did NOT happen, real moves', () => {
    render(
      <RefusalCard
        word="save refused — read-only space"
        detail="Nothing was saved; your text is kept right here."
        note="no offline queue in v1 — honestly"
        moves={[{ label: 'retry', onSelect: () => {} }]}
      />,
    );
    const card = screen.getByTestId('authoring-refusal');
    expect(card.textContent).toContain('save refused — read-only space');
    expect(card.textContent).toContain('Nothing was saved');
    expect(card.textContent).toContain('no offline queue in v1');
    expect(screen.queryByRole('button', { name: 'retry' })).not.toBeNull();
    // A refusal is announced, not merely drawn.
    expect(card.getAttribute('role')).toBe('alert');
  });
});
