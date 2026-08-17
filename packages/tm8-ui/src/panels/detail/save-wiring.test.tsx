// @vitest-environment jsdom
/**
 * THE SAVE PATH, END TO END THROUGH THE PANEL — the crossing, not the parts.
 *
 * `src/authoring/` shipped the create flow, the save flow, the inline title
 * editor, the save controls and the conflict card, all tested, all green, and
 * NONE of them mounted anywhere: the handover's own first line is "mountable,
 * not mounted". Meanwhile `chrome.tsx` rendered a `contentEditable` title span
 * with no commit handler and no seam call — inert since it was written, and
 * wearing the dotted underline that means "you can change this".
 *
 * Two green suites, one dressed-up lie between them. This file asserts the
 * wiring itself: that the panel mounts the real editor, hands it a real
 * executor, sends the version the EDIT was based on, and renders a version
 * conflict as a designed state in the BODY rather than resolving it quietly.
 *
 * === RED-FIRST RECORD (measured, restored-broken — the rowsFor precedent) ===
 *
 * The fix was already in the tree, so each break below was APPLIED to the
 * finished tree, run, captured and reverted. Instrument for both:
 * `bunx vitest run src/panels/detail/save-wiring.test.tsx` from
 * `packages/tm8-ui` (banner `RUN v4.1.10 …/packages/tm8-ui`).
 *
 *   BREAK 1 — 2026-07-29T12:43:42Z. `chrome.tsx` never mounts the editor
 *             (`const editable = false`), which is HEAD's state as far as
 *             anything here can observe: an inert title span.
 *     FAIL the title is a REAL editor and it sends patchTask
 *     FAIL sends an expectedVersion at all — the write is version-checked …
 *     FAIL MEASURES the one-gesture window: the version is taken at Enter …
 *     FAIL a version conflict renders as a DESIGNED state, in the body
 *     FAIL MEASURES what the real node actually sends on a 409 …
 *       all five: TestingLibraryElementError: Unable to find an element by:
 *       [data-testid="authoring-title"]
 *     Tests  5 failed | 4 passed (9)
 *
 *   BREAK 2 — 2026-07-29T12:43:54Z. `EntityDetailPanel` keeps the header
 *             wiring but drops `<AuthoringHost>` from the body — the
 *             plausible half-fix, and the one that would have shipped a save
 *             whose conflict state had nowhere to render.
 *     FAIL a version conflict renders as a DESIGNED state, in the body
 *     FAIL MEASURES what the real node actually sends on a 409 …
 *       both: AssertionError: expected null not to be null
 *     Tests  2 failed | 7 passed (9)
 *
 *   Restored: Tests  9 passed (9).
 */
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { CollabError, type CommandResult, type EntityDetail, type EntityId, type PatchTaskInput } from '@tm8/contract';
import { ALL_MODES, REASONS as DOMAIN_REASONS, getKind, type ActionContext } from '../../domain';
import {
  FIXTURE_SPACE_ID,
  fixtureDetails,
  presenceHollowReason,
  taskUuidTitle,
  commitFoundation,
} from '../../fixtures';
import { EntityDetailPanel, type DetailReasons } from '../index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};

/** A fixture detail is used rather than a hand-built one so the capabilities,
    the version and the state shape are the ones the app actually renders. */
const TASK: EntityDetail = fixtureDetails[taskUuidTitle.id]!;

/**
 * A REAL `CollabError`, not an error-shaped object.
 *
 * `classifyFailure` gates on `isCollabError`, which is `e instanceof
 * CollabError` — so a duck-typed `{code:'version_conflict'}` classifies as a
 * generic refusal and renders the WRONG card. Found by this test failing
 * against correct code, which is the useful direction for a test to be wrong
 * in, and it is worth knowing: anything that re-wraps an error across a
 * boundary (a worker, a JSON round-trip, a `structuredClone`) loses the
 * conflict state silently.
 */
function conflictError(currentVersion: number) {
  return new CollabError('version_conflict', 'this changed while you were editing', {
    details: { currentVersion },
  });
}

const ok = (): Promise<CommandResult> => Promise.resolve({} as CommandResult);

/** Typed so `mock.calls[0]` is the real (id, input) tuple: a `vi.fn(ok)` over
    a zero-arg impl gives an empty tuple, and every argument assertion below
    becomes a type error rather than a check. */
const patchSpy = () => vi.fn((_id: EntityId, _input: PatchTaskInput) => ok());

describe('the panel mounts the real save path', () => {
  it('keeps the description editor mounted and saves its staged text', async () => {
    if (TASK.content.kind !== 'task') throw new Error('the task fixture must carry task content');
    const savedEntity: EntityDetail = {
      ...TASK,
      version: TASK.version + 1,
      content: { ...TASK.content, description: 'Context that grows with the task.' },
    };
    const result: CommandResult = { entity: savedEntity, patches: [savedEntity] };
    const patchTask = vi.fn((_id: EntityId, _input: PatchTaskInput) => Promise.resolve(result));
    const onSaved = vi.fn();

    function SavedPanel() {
      const [detail, setDetail] = useState<EntityDetail>({
        ...TASK,
        content: { ...TASK.content, description: '' },
      });
      return (
        <EntityDetailPanel
          detail={detail}
          reasons={REASONS}
          ctx={ctx}
          commands={{ createEntity: vi.fn(ok), patchTask }}
          onSaved={(commandResult) => {
            onSaved(commandResult);
            if (commandResult.entity) setDetail(commandResult.entity);
          }}
        />
      );
    }

    const { getByRole, getByTestId } = render(
      <div className="cv2-root">
        <SavedPanel />
      </div>,
    );

    const description = getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement;
    expect(description.value).toBe('');
    fireEvent.change(description, { target: { value: 'Context that grows with the task.' } });
    fireEvent.click(getByTestId('authoring-save'));

    await waitFor(() => expect(patchTask).toHaveBeenCalledTimes(1));
    const [id, patch] = patchTask.mock.calls[0]!;
    expect(id).toBe(TASK.id);
    expect(patch).toMatchObject({
      description: 'Context that grows with the task.',
      expectedVersion: TASK.version,
    });
    expect(onSaved).toHaveBeenCalledWith(result);
    expect(description.value).toBe('Context that grows with the task.');
  });

  it('the title is a REAL editor and it sends patchTask', async () => {
    const patchTask = patchSpy();
    const { getByTestId, getByRole } = render(
      <div className="cv2-root">
        <EntityDetailPanel
          detail={TASK}
          reasons={REASONS}
          ctx={ctx}
          commands={{ createEntity: vi.fn(ok), patchTask }}
        />
      </div>,
    );

    fireEvent.click(getByTestId('authoring-title'));
    const input = getByRole('textbox', { name: 'Title' });
    fireEvent.change(input, { target: { value: 'a name someone chose' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(patchTask).toHaveBeenCalledTimes(1));
    const [id, patch] = patchTask.mock.calls[0]!;
    expect(id).toBe(TASK.id);
    expect(patch).toMatchObject({ title: 'a name someone chose' });
  });

  it('sends an expectedVersion at all — the write is version-checked, never blind', async () => {
    const patchTask = patchSpy();
    const { getByTestId, getByRole } = render(
      <div className="cv2-root">
        <EntityDetailPanel
          detail={TASK}
          reasons={REASONS}
          ctx={ctx}
          commands={{ createEntity: vi.fn(ok), patchTask }}
        />
      </div>,
    );
    fireEvent.click(getByTestId('authoring-title'));
    fireEvent.change(getByRole('textbox', { name: 'Title' }), { target: { value: 'mine' } });
    fireEvent.keyDown(getByRole('textbox', { name: 'Title' }), { key: 'Enter' });

    await waitFor(() => expect(patchTask).toHaveBeenCalledTimes(1));
    expect(patchTask.mock.calls[0]![1]).toMatchObject({ expectedVersion: TASK.version });
  });

  it('MEASURES the one-gesture window: the version is taken at Enter, not at focus', async () => {
    // NOT AN ENDORSEMENT — a measurement of a real gap (GAP-3 in
    // src/data/HANDOVER-DataWiring.md), pinned so it cannot change unnoticed.
    //
    // `useTaskSave` captures `expectedVersion` at the FIRST EDIT, which is the
    // whole mechanism that turns a concurrent write into a conflict the user
    // can answer instead of a silent overwrite. The title uses `commitNow` —
    // one gesture, stage-and-flush in the same call — so for the title the
    // "first edit" IS the Enter key, and a write that lands while the user was
    // typing is adopted rather than conflicted with.
    //
    // The live event loop makes this REACHABLE rather than theoretical: an
    // open panel now receives another writer's version mid-typing, which is
    // exactly the rerender below. The fix belongs in the authoring lane (an
    // `onBeginEdit` on `InlineTitleEditor` calling `save.edit({})`, which
    // captures the base version and leaves `dirty` false so no chip appears);
    // that directory is not this seat's to edit, so this is reported, not
    // papered over.
    const patchTask = patchSpy();
    const commands = { createEntity: vi.fn(ok), patchTask };
    const { getByTestId, getByRole, rerender } = render(
      <div className="cv2-root">
        <EntityDetailPanel detail={TASK} reasons={REASONS} ctx={ctx} commands={commands} />
      </div>,
    );

    fireEvent.click(getByTestId('authoring-title'));
    fireEvent.change(getByRole('textbox', { name: 'Title' }), { target: { value: 'mine' } });

    rerender(
      <div className="cv2-root">
        <EntityDetailPanel
          detail={{ ...TASK, version: TASK.version + 5 }}
          reasons={REASONS}
          ctx={ctx}
          commands={commands}
        />
      </div>,
    );
    fireEvent.keyDown(getByRole('textbox', { name: 'Title' }), { key: 'Enter' });

    await waitFor(() => expect(patchTask).toHaveBeenCalledTimes(1));
    expect(patchTask.mock.calls[0]![1]).toMatchObject({ expectedVersion: TASK.version + 5 });
  });

  it('a version conflict renders as a DESIGNED state, in the body', async () => {
    const patchTask = vi.fn(() => Promise.reject(conflictError(TASK.version + 3)));
    const { getByTestId, getByRole, container } = render(
      <div className="cv2-root">
        <EntityDetailPanel
          detail={TASK}
          reasons={REASONS}
          ctx={ctx}
          commands={{ createEntity: vi.fn(ok), patchTask: patchTask as never }}
        />
      </div>,
    );

    fireEvent.click(getByTestId('authoring-title'));
    fireEvent.change(getByRole('textbox', { name: 'Title' }), { target: { value: 'mine' } });
    fireEvent.keyDown(getByRole('textbox', { name: 'Title' }), { key: 'Enter' });

    const card = await waitFor(() => {
      const found = container.querySelector('[data-testid="authoring-conflict"]');
      expect(found).not.toBeNull();
      return found!;
    });

    // IN THE BODY, NOT THE HEADER. A card carrying a cause, an aftermath and
    // two moves cannot live in a 30px header row — it would be clipped, which
    // is a defect jsdom cannot see and this assertion can.
    expect(getByTestId('panel-header').contains(card)).toBe(false);
    // And it is never resolved for the user: no silent overwrite, no retry at
    // the same version (which would fail forever).
    expect(patchTask).toHaveBeenCalledTimes(1);
    // The node said which version won, so the overwrite move is offerable.
    expect(card.textContent).toContain('overwrite — keep mine');
  });

  it('MEASURES what the real node actually sends on a 409 — and what we drop', async () => {
    // GAP-4, pinned as a measurement rather than described in prose.
    //
    // `packages/server/.../entities.ts:enrichVersionConflict` decorates a
    // version conflict with `details.current` — the whole current
    // `EntityDetail`, version included. `src/data/real/http.ts:toCollabError`
    // rebuilds the error from the wire and passes `details` through but never
    // sets `opts.current`, and `classifyFailure` reads only `error.current`
    // and `details.currentVersion`. So `currentVersion` is null, and OVERWRITE
    // — the move the server sent us everything needed to offer — renders
    // disabled-with-reason against a real node.
    //
    // Two candidate one-liners, both outside this seat's files: set
    // `current: details.current` in `toCollabError`, or read
    // `details.current?.version` in `classifyFailure`. WHEN EITHER LANDS THIS
    // TEST GOES RED — that is the point of writing it this way rather than
    // leaving a sentence in a handover nobody re-reads.
    const serverShaped = new CollabError('version_conflict', 'this changed while you were editing', {
      details: { current: { ...TASK, version: TASK.version + 3, title: 'theirs' } },
    });
    const { getByTestId, getByRole, container } = render(
      <div className="cv2-root">
        <EntityDetailPanel
          detail={TASK}
          reasons={REASONS}
          ctx={ctx}
          commands={{ createEntity: vi.fn(ok), patchTask: vi.fn(() => Promise.reject(serverShaped)) as never }}
        />
      </div>,
    );

    fireEvent.click(getByTestId('authoring-title'));
    fireEvent.change(getByRole('textbox', { name: 'Title' }), { target: { value: 'mine' } });
    fireEvent.keyDown(getByRole('textbox', { name: 'Title' }), { key: 'Enter' });

    const card = await waitFor(() => {
      const found = container.querySelector('[data-testid="authoring-conflict"]');
      expect(found).not.toBeNull();
      return found!;
    });
    // The conflict IS caught and IS a designed state — that half works.
    expect(card.textContent).toContain('the node did not say which version won');
    // And the overwrite move is refused with its reason rather than guessed.
    expect(card.querySelector('[aria-disabled="true"]')).not.toBeNull();
  });
});

describe('a panel with no executor says so — it does not pretend', () => {
  it('renders Save disabled-with-reason rather than a live control', () => {
    const { getByTestId } = render(
      <div className="cv2-root">
        <EntityDetailPanel detail={TASK} reasons={REASONS} ctx={ctx} />
      </div>,
    );
    const header = getByTestId('panel-header');
    const toolbar = getByTestId('panel-toolbar');
    // Save lives with the panel actions below the title. A permanently visible
    // refusal must not steal width from a long title.
    expect(header.textContent).not.toContain('Save');
    expect(toolbar.textContent).toContain('Save');
    expect(toolbar.querySelector('[aria-disabled="true"]')).not.toBeNull();
  });

  it('does NOT dress the title as editable when nothing can save it', () => {
    // The inert-contentEditable defect, pinned from the other side: the dotted
    // underline is a promise, and it is only kept where an executor exists.
    const { container } = render(
      <div className="cv2-root">
        <EntityDetailPanel detail={TASK} reasons={REASONS} ctx={ctx} />
      </div>,
    );
    expect(container.querySelector('.au-title--editable')).toBeNull();
    expect(container.querySelector('[contenteditable]')).toBeNull();
  });
});

describe('which kinds get an edit surface is REGISTRY DATA', () => {
  it('a kind with no inline-editable field gets no editor and no Save', () => {
    const tracked = fixtureDetails[commitFoundation.id]!;
    // Guard the premise rather than assuming it: if the registry ever marks
    // this kind title-editable, the test below would pass vacuously.
    expect(getKind(tracked.kind).list.inlineEdit?.title ?? false).toBe(false);

    const { container, getByTestId } = render(
      <div className="cv2-root">
        <EntityDetailPanel
          detail={tracked}
          reasons={REASONS}
          ctx={ctx}
          commands={{ createEntity: vi.fn(ok), patchTask: vi.fn(ok) }}
        />
      </div>,
    );
    expect(container.querySelector('[data-testid="authoring-title"]')).toBeNull();
    expect(getByTestId('panel-header').textContent).not.toContain('Save');
  });

  it('every kind still renders, in every mode, with the save path mounted', () => {
    // The wiring sits above every early return in the panel, so a kind whose
    // detail is null or whose config lacks the new fields must not throw.
    for (const mode of ALL_MODES) {
      const { unmount } = render(
        <div className="cv2-root" data-mode={mode}>
          <EntityDetailPanel
            detail={null}
            reasons={REASONS}
            ctx={ctx}
            commands={{ createEntity: vi.fn(ok), patchTask: vi.fn(ok) }}
          />
        </div>,
      );
      unmount();
    }
  });
});
