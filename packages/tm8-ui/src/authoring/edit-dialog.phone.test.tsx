// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommandResult, EntityDetail, PatchEntityInput } from '@tm8/contract';
import { allKinds, titleNormalizerFor, type KindConfig } from '../domain';
import { fixtureDetails, channelDesign } from '../fixtures';
import {
  EditEntityDialog,
  draftValueFor,
  fieldKey,
  useEntityEdit,
  type AuthoringCommands,
  type DialogField,
} from './index';

/**
 * THE CREATE / EDIT FORM ON A PHONE — the surface the user filed the lane
 * against: "it's hard to write content into this surface with current UI".
 *
 * ── THE ARRANGEMENT IS CSS, SO MOST OF THE FIX IS NOT IN THIS FILE ────────
 *
 * The defect was that `authoring.css` had ZERO `[data-shell='mobile']` rules —
 * a 380px desktop card, a 48px description box and 13px inputs, on a 390px
 * screen. The fix is `authoring-phone.css`, and jsdom LOADS NO STYLESHEETS, so
 * nothing here can see a width, a height or a font size. `authoring-phone.test.ts`
 * asserts those against the stylesheet SOURCE; a jsdom test claiming to check
 * a computed font size would be a lie and should be read as one.
 *
 * ── WHAT IS LEFT FOR THIS FILE, AND IT IS THE HALF THAT ROTS ─────────────
 *
 * Two claims that a screenshot cannot make and a stylesheet cannot keep:
 *
 *   1. THE FORM IS STILL THE REGISTRY'S. The arrangement changed; the fields
 *      did not. Driven off `allKinds()` rather than a transcribed array, so a
 *      field added to a kind's `editFields` tomorrow is covered without anyone
 *      editing this file — which is the acceptance condition, and also the only
 *      version of this test that stays true.
 *   2. `expectedVersion` STILL GOES OUT. This codebase has already paid for a
 *      dropped one, and a "new arrangement" is exactly the change that drops it
 *      while every visual check passes. See the mutation record below.
 *
 * === RED-FIRST RECORD (measured; each break applied to the finished tree, run,
 * captured, reverted) ===
 * Instrument: `./node_modules/.bin/vitest run src/authoring/` from
 * `packages/tm8-ui` (banner `RUN v4.1.10 …/packages/tm8-ui`).
 * Counts are in the PR body.
 */

afterEach(cleanup);

const CHANNEL: EntityDetail = fixtureDetails[channelDesign.id]!;
const OK: CommandResult = { patches: [] } as unknown as CommandResult;

/**
 * The registry row resolved exactly as `useEntityVerbs` resolves it, including
 * the grammar → `normalize` step that `src/authoring/` may not do for itself
 * (§15.2 — this directory may not hold a `KindConfig`).
 */
function fieldsOf(config: KindConfig): readonly DialogField[] {
  return (config.editFields ?? []).map((field) => ({
    target: field.target,
    source: field.source,
    readFrom: field.readFrom,
    label: field.label,
    required: field.required,
    placeholder: field.placeholder,
    multiline: field.multiline,
    valueType: field.valueType,
    normalize: field.grammar ? titleNormalizerFor({ titleGrammar: field.grammar }) : undefined,
  }));
}

function commandsSpy() {
  const sent: PatchEntityInput[] = [];
  const patchEntity = vi.fn(async (_id: string, input: PatchEntityInput) => {
    sent.push(input);
    return OK;
  });
  return {
    commands: {
      createEntity: vi.fn(async () => OK),
      patchTask: vi.fn(async () => OK),
      patchEntity: patchEntity as unknown as AuthoringCommands['patchEntity'],
    } satisfies AuthoringCommands,
    sent,
  };
}

/**
 * The host, minus the registry lookup — fields are handed in exactly as
 * `useEntityVerbs` hands them in, and seeded the way `useEntityVerbs.openEdit`
 * seeds them (including the `readFrom: 'state'` arm, which a task's due date
 * needs and which reading `content` alone would silently blank).
 *
 * OPENED BY A CLICK, not on mount, and that is not ceremony: `flow.begin` is a
 * state write, so calling it during render leaves the tree unmounted and every
 * query in this file resolving against an empty body. Same shape as
 * `edit-dialog.test.tsx`'s harness, for the same reason.
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
  const open = () => {
    const content = (detail.content ?? {}) as Record<string, unknown>;
    const state = (detail.state ?? {}) as unknown as Record<string, unknown>;
    const seed: Record<string, string> = {};
    for (const field of fields) {
      const raw = field.target === 'title'
        ? detail.title
        : (field.readFrom === 'state' ? state : content)[field.source ?? ''];
      seed[fieldKey(field)] = draftValueFor(field, raw);
    }
    flow.begin(seed);
  };
  return (
    <div>
      <button type="button" onClick={open} data-testid="open">open</button>
      <EditEntityDialog flow={flow} fields={fields} title="Edit" />
    </div>
  );
}

/** Render the harness and get to the surface under test. */
function openForm(fields: readonly DialogField[], commands: AuthoringCommands) {
  const view = render(<Harness detail={CHANNEL} fields={fields} commands={commands} />);
  fireEvent.click(screen.getByTestId('open'));
  return view;
}

/**
 * EVERY KIND THE REGISTRY GIVES AN EDIT FORM. Not a list of kind names — this
 * directory may not name one (§15.2) — and not a fixed count either, because a
 * count pin is the assertion that fails on the day someone adds a row and
 * teaches the next reader to bump the number rather than look.
 */
const EDITABLE = allKinds().filter((config) => (config.editFields ?? []).length > 0);

describe('the phone form draws whatever the registry declares', () => {
  it('has kinds to test, so the loop below cannot pass by being empty', () => {
    /* A `for…of` over an empty array is a green test that asserts nothing, and
       it stays green forever. This is the guard that makes the next case mean
       something. */
    expect(EDITABLE.length).toBeGreaterThan(0);
  });

  it.each(EDITABLE.map((config) => [config.label, config] as const))(
    'renders every field %s declares, each with its own control and label',
    (_label, config) => {
      const fields = fieldsOf(config);
      const { commands } = commandsSpy();
      /* One detail for every kind on purpose: the dialog is handed its fields
         and knows no kind, so the SUBJECT is irrelevant to what it draws. A
         per-kind fixture would test the fixtures. */
      openForm(fields, commands);

      for (const field of fields) {
        const control = screen.getByTestId(`edit-field-${fieldKey(field)}`);
        expect(control).toBeTruthy();
        /* The label is not decoration on a phone form: with one field per row
           and no column header, it is the only thing that says what the box
           is. `getByText` would also match a placeholder, so this reads the
           rendered label element. */
        const label = control.closest('.au-dialog__field')?.querySelector('.au-dialog__label');
        expect(label?.textContent).toContain(field.label);
      }

      /* And nothing ELSE: a form that drew a field the registry did not
         declare would pass every assertion above. */
      expect(document.querySelectorAll('.au-dialog__field')).toHaveLength(fields.length);
    },
  );

  /**
   * A MULTILINE FIELD IS STILL A MULTILINE FIELD. The user's complaint is
   * about writing, and `authoring-phone.css` gives `textarea.au-dialog__input`
   * a 180px floor — a rule that matches NOTHING if the arrangement ever
   * degrades the prose field to an `<input>`. The stylesheet cannot notice; the
   * element type is the only place that fact lives in the DOM.
   */
  it('keeps the prose fields as textareas, which the 180px phone floor selects on', () => {
    const multiline = EDITABLE.flatMap((config) =>
      fieldsOf(config).filter((field) => field.multiline),
    );
    expect(multiline.length).toBeGreaterThan(0);

    for (const config of EDITABLE) {
      const fields = fieldsOf(config);
      if (!fields.some((f) => f.multiline)) continue;
      const { commands } = commandsSpy();
      const view = openForm(fields, commands);
      for (const field of fields.filter((f) => f.multiline)) {
        const control = screen.getByTestId(`edit-field-${fieldKey(field)}`);
        expect(control.tagName).toBe('TEXTAREA');
        expect(control.className).toContain('au-dialog__input');
      }
      view.unmount();
    }
  });
});

describe('the arrangement changed and the save path did not', () => {
  /**
   * THE ONE THIS FILE EXISTS FOR. `expectedVersion` is what turns a concurrent
   * write into a refusal the reader can answer instead of a silent overwrite,
   * and it is carried by a single argument through `entityPatchInput`. Dropping
   * it looks like NOTHING: the save succeeds, the dialog closes, the form is
   * beautiful on a phone, and two people's edits stopped colliding visibly.
   */
  it('still sends expectedVersion — the version the edit was made against', async () => {
    const fields = fieldsOf(allKinds().find((c) => (c.editFields ?? []).length > 0)!);
    const { commands, sent } = commandsSpy();
    openForm(fields, commands);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.expectedVersion).toBe(CHANNEL.version);
  });

  /**
   * AND THE CONFLICT IT BUYS STILL RENDERS. `authoring-phone.css` makes the
   * action row `position: sticky` inside the sheet's own scroll — a change that
   * gives one child of this form a stacking context and a background. The card
   * that reports a lost race is a SIBLING of that row, and "the refusal card is
   * behind the buttons now" is a defect with no failing test and no visible
   * symptom except on the day someone loses an edit.
   */
  it('still renders the conflict card, with a way back to the form', async () => {
    const fields = fieldsOf(allKinds().find((c) => (c.editFields ?? []).length > 0)!);
    const conflict = Object.assign(new Error('version conflict'), {
      name: 'CollabError',
      code: 'version_conflict',
    });
    const commands = {
      createEntity: vi.fn(async () => OK),
      patchTask: vi.fn(async () => OK),
      patchEntity: vi.fn(async () => {
        throw conflict;
      }),
    } as unknown as AuthoringCommands;

    openForm(fields, commands);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    const card = await screen.findByTestId('authoring-refusal');
    expect(card.textContent).toContain('back to the form');
    /* The form is still THERE underneath it — the card is a state of the
       dialog, not a replacement for it. A phone arrangement that swapped the
       fields out for the card would lose the draft behind a dismissal. */
    expect(screen.getByTestId('edit-entity-dialog')).toBeTruthy();
  });
});
