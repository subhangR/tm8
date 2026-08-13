// @vitest-environment jsdom
/**
 * THE `editFields` DIALOG, AND THE THREE THINGS IT IS FOR.
 *
 * The reported defect (task 019fd744 "feature/Channels", items 1/3/5/6) was a
 * channel wearing a task's clothes: State, Priority, Assigned, a task
 * description, acceptance criteria, a subtree and Runs. #42 fixed the CAUSE —
 * `＋ New channel` created a task — and by doing so removed every one of those
 * from the channel panel at a stroke. What it did not do, and could not, is the
 * other half: a channel's `topic` has been readable in the hub body since the
 * archetype landed and writable from NOWHERE IN THE APP. `channels.topic` is a
 * real column with a real RPC parameter (`update_channel`, 007:1078) that no
 * client call ever filled.
 *
 * So these tests hold three claims, in the order they can fail:
 *
 *   1. THE SHAPE IS THE REGISTRY'S. A field the kind declares is drawn; one it
 *      does not is not. Asserted by driving the SAME component from two
 *      different field arrays — if the component knew any kind, one of them
 *      would come out wrong.
 *   2. OPTIONAL MEANS OPTIONAL. Saving with an empty topic sends `''` and
 *      succeeds, because the column is `not null default ''` (001:504). A
 *      dialog that refused it would be inventing a constraint the database
 *      does not have — and the user ruled topic optional explicitly.
 *   3. THE PAYLOAD REACHES THE RIGHT MEMBER. `title` on the patch, `topic`
 *      inside `content`. This is the one that silently rots: `ops.patchTask`
 *      builds `content` from a closed list of TASK members and drops the rest,
 *      so a dialog routed through it would report success having saved half.
 *
 * === RED-FIRST RECORD (measured; each break applied to the finished tree,
 * run, captured, reverted) ===
 * Instrument: `npx vitest run src/authoring/edit-dialog.test.tsx`
 * from `packages/tm8-ui` (banner `RUN v4.1.10 …/packages/tm8-ui`).
 *
 *   BREAK 1 — route the save through `patchTask` instead of `patchEntity`,
 *             i.e. the defect this file exists to prevent.
 *     FAIL an optional field left empty is SENT, not omitted
 *     FAIL the payload puts title on the patch and content members inside it
 *     Tests  2 failed | 8 passed (10)
 *
 *   BREAK 2 — treat every field as required (drop the `field.required &&`
 *             guard in `missingRequired`).
 *     FAIL an optional field may be left empty, and Save stays live
 *     FAIL an optional field left empty is SENT, not omitted
 *     FAIL the projection and its inverse agree, field for field
 *     Tests  3 failed | 7 passed (10)
 *
 *   BREAK 3 — drop the per-keystroke `normalize` on the input's onChange.
 *     FAIL a slug-grammar field normalises AS YOU TYPE, visibly
 *     Tests  1 failed | 9 passed (10)
 *
 *   Restored: Tests  10 passed (10).
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommandResult, EntityDetail, PatchEntityInput } from '@tm8/contract';
import { slugifyTitle } from '../domain';
import { fixtureDetails, channelDesign, taskUuidTitle } from '../fixtures';
import {
  EditEntityDialog,
  draftValueFor,
  editsFrom,
  fieldProblem,
  fieldKey,
  missingRequired,
  useEntityEdit,
  type AuthoringCommands,
  type DialogField,
} from './index';

afterEach(cleanup);

const CHANNEL: EntityDetail = fixtureDetails[channelDesign.id]!;
const TASK: EntityDetail = fixtureDetails[taskUuidTitle.id]!;

/** The channel's registry shape, resolved as the host resolves it. */
const CHANNEL_FIELDS: readonly DialogField[] = [
  { target: 'title', label: 'Name', required: true, normalize: slugifyTitle },
  { target: 'content', source: 'topic', label: 'Topic', multiline: true },
];

/** A second, DIFFERENT shape — the proof the component knows no kind. */
const OTHER_FIELDS: readonly DialogField[] = [
  { target: 'title', label: 'Title', required: true },
  { target: 'content', source: 'description', label: 'Description', multiline: true },
];

const OK: CommandResult = { patches: [] } as unknown as CommandResult;

function commandsSpy(over: Partial<AuthoringCommands> = {}) {
  const patchEntity = vi.fn(async () => OK);
  const commands: AuthoringCommands = {
    createEntity: vi.fn(async () => OK),
    patchTask: vi.fn(async () => OK),
    patchEntity: patchEntity as unknown as AuthoringCommands['patchEntity'],
    ...over,
  };
  return { commands, patchEntity };
}

/**
 * The host, minus the registry lookup — the fields are handed in, exactly as
 * `useEntityVerbs` hands them in, so this file tests the dialog and not the
 * registry. `views/entity-verbs.test.tsx` holds the other seam.
 */
function Harness({
  detail,
  fields,
  commands,
}: {
  detail: EntityDetail;
  fields: readonly DialogField[];
  commands: AuthoringCommands | null;
}) {
  const flow = useEntityEdit({ detail, commands });
  const [opened, setOpened] = useState(false);
  const content = (detail.content ?? {}) as Record<string, unknown>;
  const open = () => {
    const seed: Record<string, string> = {};
    for (const f of fields) {
      const raw = f.target === 'title' ? detail.title : content[f.source ?? ''];
      seed[fieldKey(f)] = typeof raw === 'string' ? raw : '';
    }
    flow.begin(seed);
    setOpened(true);
  };
  return (
    <div>
      <button type="button" onClick={open} data-testid="open">
        open
      </button>
      <span data-testid="opened">{String(opened)}</span>
      <EditEntityDialog flow={flow} fields={fields} title="Edit channel" />
    </div>
  );
}

function openDialog(fields = CHANNEL_FIELDS, detail = CHANNEL, over: Partial<AuthoringCommands> = {}) {
  const { commands, patchEntity } = commandsSpy(over);
  render(<Harness detail={detail} fields={fields} commands={commands} />);
  fireEvent.click(screen.getByTestId('open'));
  return { patchEntity, commands };
}

// ---------------------------------------------------------------------------
// 1. The shape is the registry's
// ---------------------------------------------------------------------------

describe('the dialog draws what the kind declared, and knows no kind itself', () => {
  it('draws the channel shape: a required Name and an optional Topic', () => {
    openDialog();
    expect(screen.getByTestId('edit-field-title')).toBeTruthy();
    expect(screen.getByTestId('edit-field-content.topic')).toBeTruthy();
    // The optional marker is on Topic and NOT on Name — said out loud, because
    // the opposite convention would read as "Name is also expected, unstarred".
    const labels = [...document.querySelectorAll('.au-dialog__label')].map((n) => n.textContent);
    expect(labels).toEqual(['Name', 'Topic · optional']);
  });

  it('draws a DIFFERENT shape from a different array, same component', () => {
    openDialog(OTHER_FIELDS, TASK);
    expect(screen.getByTestId('edit-field-content.description')).toBeTruthy();
    expect(screen.queryByTestId('edit-field-content.topic')).toBeNull();
  });

  it('renders nothing at all for a kind that declares no fields', () => {
    openDialog([], CHANNEL);
    expect(screen.queryByTestId('edit-entity-dialog')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Required is the server's constraint; optional is too
// ---------------------------------------------------------------------------

describe('required and optional are the database’s words, not the form’s', () => {
  it('an empty REQUIRED field refuses before spending a round trip', async () => {
    const { patchEntity } = openDialog();
    fireEvent.change(screen.getByTestId('edit-field-title'), { target: { value: '' } });

    const save = screen.getByText('Save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // The reason is ON SCREEN, not only in the disabled attribute.
    expect(screen.getByRole('alert').textContent).toContain('Name is required');

    fireEvent.click(save);
    await waitFor(() => expect(patchEntity).not.toHaveBeenCalled());
  });

  it('an optional field may be left empty, and Save stays live', () => {
    openDialog();
    fireEvent.change(screen.getByTestId('edit-field-content.topic'), { target: { value: '' } });
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('an optional field left empty is SENT, not omitted', async () => {
    const { patchEntity } = openDialog();
    fireEvent.change(screen.getByTestId('edit-field-content.topic'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));
    const [, input] = patchEntity.mock.calls[0] as unknown as [string, PatchEntityInput];
    /*
     * `''` AND NOT AN OMISSION, and the difference is the whole point:
     * `update_channel` COALESCEs a null topic to the EXISTING one (007:1095),
     * so omitting the member would make "clear the topic" silently do nothing.
     */
    expect((input.content as Record<string, unknown>).topic).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 3. The payload reaches the right member
// ---------------------------------------------------------------------------

describe('the payload is the contract’s shape', () => {
  it('puts title on the patch and content members inside content', async () => {
    const { patchEntity } = openDialog();
    fireEvent.change(screen.getByTestId('edit-field-title'), { target: { value: 'design-review' } });
    fireEvent.change(screen.getByTestId('edit-field-content.topic'), { target: { value: 'ship it' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));
    const [id, input] = patchEntity.mock.calls[0] as unknown as [string, PatchEntityInput];
    expect(id).toBe(CHANNEL.id);
    expect(input.title).toBe('design-review');
    expect(input.content).toEqual({ topic: 'ship it' });
    // The version the draft was made against — not re-read at save time.
    expect(input.expectedVersion).toBe(CHANNEL.version);
    expect(typeof input.clientMutationId).toBe('string');
  });

  it('a slug-grammar field normalises AS YOU TYPE, visibly', () => {
    openDialog();
    const name = screen.getByTestId('edit-field-title') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Design Review' } });
    /*
     * The USER SEES the legal name forming. Rewriting it silently on submit is
     * the other available design and it is the one that produces "I saved
     * something and got something else" — the same class of surprise as the
     * opaque `invariant_violation` #42 was filed for.
     */
    expect(name.value).toBe('design-review');
  });

  it('the projection and its inverse agree, field for field', () => {
    // `editsFrom` writes what the seeding loop reads. Held here because the two
    // live in different files and nothing else would notice them drifting.
    const values = { title: 'a-name', 'content.topic': 'a topic' };
    expect(editsFrom(CHANNEL_FIELDS, values)).toEqual({
      title: 'a-name',
      content: { topic: 'a topic' },
    });
    expect(missingRequired(CHANNEL_FIELDS, values)).toEqual([]);
    expect(missingRequired(CHANNEL_FIELDS, { title: '   ' }).map((f) => f.label)).toEqual(['Name']);
  });
});

describe('typed loop fields preserve the loop door semantics', () => {
  const fields: readonly DialogField[] = [
    { target: 'content', source: 'schedule', label: 'Schedule', required: true, valueType: 'schedule' },
    { target: 'content', source: 'teamMemberId', label: 'Runner', valueType: 'nullable-text' },
    { target: 'content', source: 'subjectId', label: 'Subject', valueType: 'nullable-text' },
    { target: 'content', source: 'config', label: 'Config', valueType: 'json-object' },
  ];

  it('clears nullable ids, parses config, and reschedules only a changed schedule', () => {
    const now = new Date('2026-08-09T12:00:00.000Z');
    const initial = {
      'content.schedule': 'every 1d',
      'content.teamMemberId': '019fe999-0000-7000-8000-000000000003',
      'content.subjectId': '019fe999-0000-7000-8000-000000000004',
      'content.config': '{}',
    };
    const edits = editsFrom(fields, {
      'content.schedule': 'every 2h',
      'content.teamMemberId': '',
      'content.subjectId': '',
      'content.config': '{"model":"opus"}',
    }, initial, now);
    expect(edits.content).toEqual({
      schedule: 'every 2h',
      teamMemberId: null,
      subjectId: null,
      config: { model: 'opus' },
      nextRunAt: '2026-08-09T14:00:00.000Z',
    });

    const unchanged = editsFrom(fields, initial, initial, now);
    expect(unchanged.content).not.toHaveProperty('nextRunAt');
  });

  it('formats stored JSON for editing and refuses non-object JSON', () => {
    const config = fields[3]!;
    expect(draftValueFor(config, { model: 'opus' })).toContain('"model": "opus"');
    expect(fieldProblem(config, '[]')).toContain('JSON object');
    expect(fieldProblem(config, '{')).toContain('valid JSON');
    expect(fieldProblem(fields[0]!, 'tomorrow')).toContain('5 fields');
  });
});

// ---------------------------------------------------------------------------
// 4. A date is a calendar day, and an emptied one is a CLEAR
// ---------------------------------------------------------------------------

/**
 * THE DUE DATE, AND THE ONE WAY IT CAN SILENTLY GO WRONG.
 *
 * `dueDate` was modelled end to end and writable from nowhere: the column, the
 * `PatchTaskInput` member, the `::date` sort and the read projection all
 * existed, and no control in the app ever filled one. Adding the control is the
 * easy half. The half that fails quietly is the CLEAR — `update_task_content`
 * COALESCEs an absent `dueDate` to the stored value and treats only an explicit
 * `null` as "remove it" (`handlers/entities.ts:682-685`). A patch built the
 * ordinary way, sending changed fields and omitting empty ones, therefore
 * reports success and leaves yesterday's date in place.
 *
 * So these hold the two directions separately, plus the shape in between.
 */
describe('a date field writes a calendar day and clears with an explicit null', () => {
  const DUE: DialogField = {
    target: 'content', source: 'dueDate', readFrom: 'state', label: 'Due date', valueType: 'date',
  };
  const TASK_FIELDS: readonly DialogField[] = [{ target: 'title', label: 'Title', required: true }, DUE];

  it('draws the native picker rather than a text box', () => {
    openDialog(TASK_FIELDS, TASK);
    const input = screen.getByTestId('edit-field-content.dueDate') as HTMLInputElement;
    /*
     * `type="date"` is the whole guarantee that the draft is `YYYY-MM-DD` or
     * empty and never a locale string the column would refuse. A text box here
     * would move that problem onto the person typing.
     */
    expect(input.type).toBe('date');
  });

  it('sends the day the user picked, inside content', async () => {
    const { patchEntity } = openDialog(TASK_FIELDS, TASK);
    fireEvent.change(screen.getByTestId('edit-field-content.dueDate'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));
    const [, input] = patchEntity.mock.calls[0] as unknown as [string, PatchEntityInput];
    expect((input.content as Record<string, unknown>).dueDate).toBe('2026-09-01');
  });

  it('sends an explicit NULL when the date is emptied — the only thing that clears it', async () => {
    const { patchEntity } = openDialog(TASK_FIELDS, TASK);
    fireEvent.change(screen.getByTestId('edit-field-content.dueDate'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));
    const [, input] = patchEntity.mock.calls[0] as unknown as [string, PatchEntityInput];
    const content = input.content as Record<string, unknown>;
    /*
     * BOTH ASSERTIONS EARN THEIR PLACE. `null` is what the server reads as a
     * clear; `'dueDate' in content` is what fails if a future "omit unchanged
     * members" optimisation drops the key — at which point the value assertion
     * alone would still pass on `undefined === undefined` under a loose read.
     */
    expect(content.dueDate).toBeNull();
    expect('dueDate' in content).toBe(true);
  });

  it('reads the stored day from STATE, where the server actually puts it', () => {
    /*
     * `contentOf` builds a task's content from description, acceptanceCriteria
     * and pointsEstimate only (`entity-read.ts:1502-1508`); `stateOf` is what
     * projects `due_date` (`:1112`). A field seeded from content would open
     * BLANK on a task that has a due date — and since blank means null, the
     * next Save would delete it without anyone touching the box.
     */
    expect(DUE.readFrom).toBe('state');
    expect(draftValueFor(DUE, '2026-07-30')).toBe('2026-07-30');
  });

  it('truncates a timestamp to its day and refuses what is not a date', () => {
    // The column is a `date`, but a value that arrived as a timestamp must not
    // blank the control — a blank control is a pending deletion.
    expect(draftValueFor(DUE, '2026-07-30T11:00:00.000Z')).toBe('2026-07-30');
    expect(draftValueFor(DUE, null)).toBe('');

    expect(fieldProblem(DUE, '')).toBeNull();
    expect(fieldProblem(DUE, '2026-07-30')).toBeNull();
    expect(fieldProblem(DUE, 'tomorrow')).toContain('calendar date');
    // Shaped like a date, and not one. Postgres refuses this as an opaque
    // `invariant_violation`, which is the failure #42 was filed for.
    expect(fieldProblem(DUE, '2026-02-30')).toContain('calendar date');
  });

  it('an empty date leaves Save live — no due date is a value, not a hole', () => {
    openDialog(TASK_FIELDS, TASK);
    fireEvent.change(screen.getByTestId('edit-field-content.dueDate'), { target: { value: '' } });
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Honesty states
// ---------------------------------------------------------------------------

describe('an unwired dialog refuses visibly rather than looking live', () => {
  it('says why, and disables Save', () => {
    render(<Harness detail={CHANNEL} fields={CHANNEL_FIELDS} commands={null} />);
    fireEvent.click(screen.getByTestId('open'));
    expect(screen.getByRole('note').textContent).toContain('Editing is not wired here');
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true);
  });
});
