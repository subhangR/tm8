// @vitest-environment jsdom
/**
 * THE PANEL ACTION BAR'S WIRING — `edit`, and subchannels.
 *
 * TWO DEFECTS MEET IN THIS FILE, and only one of them is new.
 *
 * `add-child` has been declared on `channel` and `doc` since those registry
 * rows were written, and it rendered DISABLED-WITH-REASON on every panel in
 * the app for the whole time — no host ever passed an `onAction` at all, so
 * `ActionBar`'s structural check refused every primary it was given. The graph
 * was ready the entire time: `entities.parentId` is kind-agnostic and the
 * channel row already declares `tree: { by: 'hierarchy' }`. So "channels can
 * have subchannels" (user ruling 2026-08-07) was a WIRING gap, not a schema
 * one, and the fix is a host that dispatches the verb — not a new column.
 *
 * Wiring it exposes the second defect, which is why this file holds both:
 * `onAction` is ALL-OR-NOTHING. The moment a host passes one, every primary
 * beside the wired verb goes live too — including verbs the host's switch has
 * no arm for. That is enabled-and-inert (R5 #9) arrived at from the opposite
 * direction: the honesty check that was right while nothing was wired becomes
 * a lie the instant something is. `wiredActions` is the fix, and it is DERIVED
 * from the handler map so the advertisement cannot drift from the dispatch.
 *
 * === RED-FIRST RECORD (measured; each break applied to the finished tree,
 * run, captured, reverted) ===
 * Instrument: `npx vitest run src/views/entity-verbs.test.tsx`
 * from `packages/tm8-ui` (banner `RUN v4.1.10 …/packages/tm8-ui`).
 *
 *   BREAK 1 — ignore `wiredActions` in `ActionButton` (the pre-existing
 *             all-or-nothing behaviour, which is HEAD's state).
 *     FAIL a verb the host does NOT handle stays disabled-with-reason
 *     Tests  1 failed | 6 passed (7)
 *
 *   BREAK 2 — drop `parentId` from `newEntityInput`'s payload, i.e. build the
 *             subchannel verb as a plain create.
 *     FAIL add-child creates a child OF THE OPEN ENTITY, same kind
 *     Tests  1 failed | 6 passed (7)
 *
 *   Restored: Tests  7 passed (7).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommandResult, CreateEntityInput, EntityDetail, SpaceId } from '@tm8/contract';
import { getKind, REASONS as DOMAIN_REASONS, type ActionContext, type ActionRef } from '../domain';
import { FIXTURE_SPACE_ID, channelDesign, fixtureDetails, presenceHollowReason, taskUuidTitle } from '../fixtures';
import { EntityDetailPanel, type DetailReasons } from '../panels';
import { EditEntityDialog, type AuthoringCommands } from '../authoring';
import { ENTITY_VERB_ACTIONS, useEntityVerbs } from './useEntityVerbs';

afterEach(cleanup);

const CHANNEL: EntityDetail = fixtureDetails[channelDesign.id]!;
const TASK: EntityDetail = fixtureDetails[taskUuidTitle.id]!;
const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'x',
  shareUnavailable: 'x',
  withdrawUnavailable: 'x',
};

const OK: CommandResult = { entity: { id: 'new-id' }, patches: [] } as unknown as CommandResult;

function commandsSpy() {
  const createEntity = vi.fn(async () => OK);
  const patchEntity = vi.fn(async () => OK);
  const commands = {
    createEntity, patchEntity, patchTask: vi.fn(async () => OK),
  } as unknown as AuthoringCommands;
  return { commands, createEntity, patchEntity };
}

/** The real panel, driven by the real hook — the seam this file exists to hold. */
function Host({
  detail,
  commands,
  onCreated,
}: {
  detail: EntityDetail;
  commands: AuthoringCommands | null;
  onCreated?: (id: string) => void;
}) {
  const verbs = useEntityVerbs({
    detail,
    spaceId: FIXTURE_SPACE_ID as SpaceId,
    commands,
    ...(onCreated ? { onCreated: (id: string) => onCreated(id) } : {}),
  });
  return (
    <EntityDetailPanel
      detail={detail}
      reasons={REASONS}
      ctx={{ ...ctx, entityId: detail.id }}
      controls={null}
      onAction={verbs.onAction}
      wiredActions={verbs.wiredActions}
    />
  );
}

describe('the channel panel offers the two verbs its registry row declares', () => {
  it('draws Edit and Add child as LIVE buttons, not disabled placeholders', () => {
    const { commands } = commandsSpy();
    render(<Host detail={CHANNEL} commands={commands} />);
    const bar = screen.getByTestId('panel-action-bar');
    const labels = [...bar.querySelectorAll('button')].map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Edit', 'Add child']);
  });

  it('the registry is what put them there, in its own order', () => {
    // Not a literal list: read back from the row, so a re-order in the registry
    // moves this assertion rather than breaking it for the wrong reason.
    expect(getKind('channel').panel.primaries).toEqual(['edit', 'add-child']);
  });

  it('a verb the host does NOT handle stays disabled-with-reason', () => {
    const { commands } = commandsSpy();
    // A task declares `run`/`complete` primaries; this host wires neither, and
    // the bar must keep saying so even though `onAction` is now non-null.
    render(<Host detail={TASK} commands={commands} />);
    const bar = screen.getByTestId('panel-action-bar');
    const live = [...bar.querySelectorAll('button')].map((b) => b.textContent?.trim());
    const refused = [...bar.querySelectorAll('[data-testid="disabled-with-reason"]')];
    expect(live).not.toContain('Run');
    expect(refused.length).toBeGreaterThan(0);
  });
});

describe('add-child is the subchannel verb', () => {
  it('creates a child OF THE OPEN ENTITY, same kind', async () => {
    const { commands, createEntity } = commandsSpy();
    render(<Host detail={CHANNEL} commands={commands} />);

    fireEvent.click(screen.getByText('Add child'));
    await waitFor(() => expect(createEntity).toHaveBeenCalledTimes(1));

    const [input] = createEntity.mock.calls[0] as unknown as [CreateEntityInput];
    expect(input.kind).toBe(CHANNEL.kind);
    // THE WHOLE SUBCHANNEL MECHANISM, in one member.
    expect(input.parentId).toBe(CHANNEL.id);
    expect(input.spaceId).toBe(FIXTURE_SPACE_ID);
  });

  it('the placeholder name is legal AND unique — the create commits before typing', async () => {
    const { commands, createEntity } = commandsSpy();
    const { unmount } = render(<Host detail={CHANNEL} commands={commands} />);
    fireEvent.click(screen.getByText('Add child'));
    await waitFor(() => expect(createEntity).toHaveBeenCalledTimes(1));
    unmount();

    render(<Host detail={CHANNEL} commands={commands} />);
    fireEvent.click(screen.getByText('Add child'));
    await waitFor(() => expect(createEntity).toHaveBeenCalledTimes(2));

    const titles = createEntity.mock.calls.map((c) => (c[0] as unknown as CreateEntityInput).title);
    // `channels_space_id_name_key` is unique per space: two subchannels in a
    // row is the case that would 409 on a shared placeholder.
    expect(titles[0]).not.toBe(titles[1]);
    for (const title of titles) expect(title).toMatch(/^[a-z0-9][a-z0-9_-]{0,79}$/);
  });

  it('hands the new id back so the host can open it', async () => {
    const { commands } = commandsSpy();
    const onCreated = vi.fn();
    render(<Host detail={CHANNEL} commands={commands} onCreated={onCreated} />);
    fireEvent.click(screen.getByText('Add child'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-id'));
  });
});

describe('edit opens the dialog for the SUBJECT’s kind, not the list’s', () => {
  it('a channel subject resolves the channel’s fields', () => {
    const { commands } = commandsSpy();
    // The LAST render's answer, not an accumulation across renders — the hook
    // may settle over more than one pass and only its settled value is a claim.
    let fields: readonly string[] = [];
    let title = '';
    function Probe() {
      const verbs = useEntityVerbs({ detail: CHANNEL, spaceId: FIXTURE_SPACE_ID as SpaceId, commands });
      fields = verbs.editFields.map((f) => f.label);
      title = verbs.editTitle;
      return null;
    }
    render(<Probe />);
    expect(fields).toEqual(['Name', 'Topic']);
    // Built from the registry `label`, so a renamed kind renames the dialog.
    expect(title).toBe('Edit channel');
  });
});

/**
 * THE DUE DATE'S SEAM — where the field is READ from, and why it is not where
 * it is written.
 *
 * `edit-dialog.test.tsx` holds the dialog's own semantics against hand-made
 * field arrays. This holds the crossing the dialog cannot see: the registry
 * names `content.dueDate`, and the value that seeds it comes out of
 * `EntityDetail.state` because that is the only place the server puts it
 * (`stateOf`, `entity-read.ts:1112`; `contentOf` at `:1502-1508` does not
 * carry it).
 *
 * THE FAILURE THIS PREVENTS IS SILENT AND DESTRUCTIVE. Seeded from `content`,
 * the box opens EMPTY on a task that has a due date; an empty date field is an
 * explicit `null`; so pressing Save without touching anything deletes the date
 * and reports success. Nothing else in the suite would have noticed — the
 * dialog tests pass their own seed in, and the registry test only reads data.
 */
describe('the task’s due date is seeded from state and patched into content', () => {
  function openTaskDialog() {
    const { commands, patchEntity } = commandsSpy();
    function Probe() {
      const verbs = useEntityVerbs({ detail: TASK, spaceId: FIXTURE_SPACE_ID as SpaceId, commands });
      return (
        <div>
          <button type="button" data-testid="go" onClick={() => verbs.onAction('edit')}>go</button>
          <EditEntityDialog flow={verbs.edit} fields={verbs.editFields} title={verbs.editTitle} />
        </div>
      );
    }
    render(<Probe />);
    fireEvent.click(screen.getByTestId('go'));
    return { patchEntity };
  }

  it('opens showing the date the task actually has', () => {
    openTaskDialog();
    const input = screen.getByTestId('edit-field-content.dueDate') as HTMLInputElement;
    // The fixture's task carries this in `state.dueDate` and NOT in content —
    // which is exactly the shape the node produces.
    expect(taskUuidTitle.state).toMatchObject({ dueDate: '2026-07-30' });
    expect((TASK.content as Record<string, unknown>).dueDate).toBeUndefined();
    expect(input.value).toBe('2026-07-30');
  });

  it('saving an untouched dialog PRESERVES the date rather than clearing it', async () => {
    const { patchEntity } = openTaskDialog();
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));
    const [, input] = patchEntity.mock.calls[0] as unknown as [string, { content?: Record<string, unknown> }];
    expect(input.content?.dueDate).toBe('2026-07-30');
  });

  it('clearing the box sends an explicit null, the only thing the server reads as a clear', async () => {
    const { patchEntity } = openTaskDialog();
    fireEvent.change(screen.getByTestId('edit-field-content.dueDate'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));
    const [, input] = patchEntity.mock.calls[0] as unknown as [string, { content?: Record<string, unknown> }];
    expect(input.content).toHaveProperty('dueDate', null);
  });
});

describe('ENTITY_VERB_ACTIONS is the handler map, not a second statement of it', () => {
  it('a subject that can do everything wires exactly the advertised set', () => {
    // `panel-primaries-wired.test.tsx` reads the constant to decide which
    // primaries have NO executor anywhere. If the map grew a verb and the
    // constant did not, that guard would go on calling a wired verb refused.
    const { commands } = commandsSpy();
    let wired: readonly ActionRef[] = [];
    function Probe() {
      wired = useEntityVerbs({ detail: CHANNEL, spaceId: FIXTURE_SPACE_ID as SpaceId, commands }).wiredActions;
      return null;
    }
    render(<Probe />);
    expect([...wired].sort()).toEqual([...ENTITY_VERB_ACTIONS].sort());
  });
});
