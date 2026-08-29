// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { isCollabError, type EntityDetail, type EntityId, type SpaceId } from '@tm8/contract';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import type { Seam } from '../data/seam';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { DocEditor, docBodyOf, docPatchInput, useDocSave, type DocCommands } from './index';

/**
 * THE TEST THAT LIVES IN THE GAP (brief §4.3 / D57.1).
 *
 * The chain for this surface is declaration → data → implementation → CALL:
 *   declaration    `Seam['commands'].patchEntity` (src/data/seam.ts:201)
 *   implementation `seam-fixture.ts:677`, which calls `requireVersion`
 *   CALL           `useDocSave` → `docPatchInput` → that method, with the
 *                  version the user's edit was actually based on
 *
 * Every link can be green while the feature is dead. The specific way it dies
 * here is the one this whole surface exists to prevent: a save that sends the
 * CURRENT version instead of the base version never conflicts, so it silently
 * overwrites the other writer — and no unit test that keeps the version still
 * can see it. So this file drives the REAL fixture seam through the REAL
 * component and asserts against the DATASET, not against a spy.
 *
 * No adapter and no cast anywhere below: `DocCommands` is a structural subset
 * of `Seam['commands']`, so the assignment on line ~40 is the compile-time
 * half of the crossing assertion and stops compiling if bridge changes the
 * signature.
 */

afterEach(cleanup);

const SPACE = FIXTURE_SPACE_ID as SpaceId;

/**
 * AN EDITABLE DOC. `doc-layout-spec` is deliberately NOT one — the fixture
 * gives it `CAPS_READONLY` with the comment "restricted doc: viewer can look
 * (summary-level), not touch". That is a designed honesty fixture, and the
 * first draft of this file used it by name and got a read-only editor, which
 * is the right answer to the wrong question. Both docs are exercised below:
 * this one for the write path, that one for the refusal.
 */
const DOC = 'doc-chapter-floors' as EntityId;
const RESTRICTED_DOC = 'doc-layout-spec' as EntityId;

function seamOf(): { seam: Seam; commands: DocCommands } {
  const seam = createFixtureSeam();
  // THE CROSSING, at the type level: no adapter, no cast, no optional chain.
  const commands: DocCommands = seam.commands;
  return { seam, commands };
}

describe('the doc port IS the real seam', () => {
  it('accepts seam.commands with neither adapter nor cast, and patchEntity is live', () => {
    const { commands } = seamOf();
    expect(typeof commands.patchEntity).toBe('function');
  });

  it('a doc patch really changes the body the seam reads back', async () => {
    const { seam, commands } = seamOf();
    await seam.openSpace(SPACE);
    const before = await seam.entity(DOC);

    await commands.patchEntity(DOC, docPatchInput({ body: '# Rewritten\n\nby the gap test.' }, before.version));

    const after = await seam.entity(DOC);
    // THE ASSERTION IS ABOUT THE DATASET. A resolved promise proves the call
    // was accepted, not that the write landed where the reader looks.
    expect(docBodyOf(after)).toContain('by the gap test.');
    expect(after.version).toBeGreaterThan(before.version);
    seam.dispose();
  });

  it('the executor really enforces expectedVersion — the 409 is a fact, not a fixture pose', async () => {
    const { seam, commands } = seamOf();
    await seam.openSpace(SPACE);
    const before = await seam.entity(DOC);

    await commands.patchEntity(DOC, docPatchInput({ body: 'first writer' }, before.version));

    let caught: unknown = null;
    try {
      // The SAME version again — this is what a stale draft sends.
      await commands.patchEntity(DOC, docPatchInput({ body: 'second writer' }, before.version));
    } catch (e) {
      caught = e;
    }
    expect(isCollabError(caught)).toBe(true);
    if (isCollabError(caught)) expect(caught.code).toBe('version_conflict');

    // And the first writer's text is still what is stored — the refusal
    // refused, it did not half-apply.
    expect(docBodyOf(await seam.entity(DOC))).toBe('first writer');
    seam.dispose();
  });
});

/**
 * The host below is the mount the handover describes, built out of the real
 * seam. `reloadNonce` exists so a mid-draft version bump can be delivered the
 * way a live app delivers one — through a re-render with fresh detail — which
 * is the only way to reproduce the race the base-version rule answers.
 */
function Host({
  seam,
  id = DOC,
  onDetail,
}: {
  seam: Seam;
  id?: EntityId;
  onDetail?: (d: EntityDetail) => void;
}) {
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  useState(() => {
    void seam.entity(id).then((d) => {
      setDetail(d);
      onDetail?.(d);
    });
    return null;
  });
  const save = useDocSave({ detail, commands: seam.commands, onReload: setDetail });
  if (!detail) return null;
  return <DocEditor save={save} detail={detail} />;
}

describe('the editor, the hook and the seam, driven end to end', () => {
  it('typing and saving lands the text in the dataset', async () => {
    const seam = createFixtureSeam();
    await seam.openSpace(SPACE);
    render(<Host seam={seam} />);
    await act(async () => {});

    const area = await screen.findByTestId('doc-source');
    fireEvent.change(area, { target: { value: '# Floors\n\nfloors are law.' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });

    expect(docBodyOf(await seam.entity(DOC))).toBe('# Floors\n\nfloors are law.');
    seam.dispose();
  });

  it('THE SILENT-OVERWRITE GUARD: a write that lands mid-draft produces a visible conflict, not a quiet clobber', async () => {
    const seam = createFixtureSeam();
    await seam.openSpace(SPACE);
    render(<Host seam={seam} />);
    await act(async () => {});

    const area = await screen.findByTestId('doc-source');
    // The user starts typing — this captures the base version.
    fireEvent.change(area, { target: { value: 'my draft' } });

    // Someone else saves while the draft is open.
    const current = await seam.entity(DOC);
    await seam.commands.patchEntity(DOC, docPatchInput({ body: 'their text' }, current.version));

    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });

    // The conflict is ON SCREEN, in the banner the oracle draws — and the
    // draft survived it, which is the promise the copy makes.
    expect(screen.getByTestId('doc-conflict-banner')).toBeTruthy();
    expect((area as HTMLTextAreaElement).value).toBe('my draft');
    // And nothing was overwritten.
    expect(docBodyOf(await seam.entity(DOC))).toBe('their text');
    seam.dispose();
  });

  it('overwrite — keep mine — really republishes over their version', async () => {
    const seam = createFixtureSeam();
    await seam.openSpace(SPACE);
    render(<Host seam={seam} />);
    await act(async () => {});

    const area = await screen.findByTestId('doc-source');
    fireEvent.change(area, { target: { value: 'my draft' } });
    const current = await seam.entity(DOC);
    await seam.commands.patchEntity(DOC, docPatchInput({ body: 'their text' }, current.version));
    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-save'));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('doc-overwrite'));
    });

    expect(docBodyOf(await seam.entity(DOC))).toBe('my draft');
    seam.dispose();
  });

  /**
   * PERMISSION HONESTY AGAINST REAL DATA, not a hand-built `canEdit: false`.
   * The fixture's restricted doc is the one entity in the dataset that says no,
   * and the surface has to say it back — visibly, with a reason, and with the
   * text unable to be typed into rather than typed and silently lost.
   */
  it('the restricted doc renders read-only with its reason, through the real seam', async () => {
    const seam = createFixtureSeam();
    await seam.openSpace(SPACE);
    render(<Host seam={seam} id={RESTRICTED_DOC} />);
    await act(async () => {});

    const area = (await screen.findByTestId('doc-source')) as HTMLTextAreaElement;
    expect(area.readOnly).toBe(true);
    expect(screen.queryByTestId('doc-save')).toBeNull();
    expect(screen.getByTestId('disabled-with-reason')).toBeTruthy();

    const before = docBodyOf(await seam.entity(RESTRICTED_DOC));
    fireEvent.change(area, { target: { value: 'should never land' } });
    await act(async () => {});
    expect(docBodyOf(await seam.entity(RESTRICTED_DOC))).toBe(before);
    seam.dispose();
  });
});
