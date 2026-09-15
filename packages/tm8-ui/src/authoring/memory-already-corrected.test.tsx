// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { CollabError } from '@tm8/contract';
import type { CreatableEntityKind, EntityId, SpaceId } from '@tm8/contract';
import { useMemoryMarks } from './useMemoryMarks';
import { alreadyCorrectedNotice, alreadyCorrectedRefusal } from '../domain/memory';

/**
 * SOMEBODY ELSE CORRECTED THIS MEMORY FIRST — what the person is told.
 *
 * A memory is replaced, never edited, and it keeps exactly one replacement, so
 * two people who both decide the same claim is wrong cannot both win. The
 * database now says no to the second one. The whole value of saying no is in
 * what the loser is told next: a raw database error teaches them nothing, and
 * "try again" is worse than nothing, because the same write against the same
 * memory is refused forever.
 *
 * So these assertions are about the SENTENCE, not the plumbing:
 *   · the other correction's own words are there, in full, to be judged;
 *   · no identifier appears anywhere in it;
 *   · it says where the words the person just typed actually went, because
 *     they WERE saved and telling them otherwise sends them to retype;
 *   · it names the move that works — correct the other correction.
 */

const CORRECTION =
  'The nightly sweep runs at 04:00 UTC, not 02:00, and it skips spaces that hold no memories at all.';

/** Exactly the shape the node sends: the words, and the reason token. */
function refusal(): CollabError {
  return new CollabError('invariant_violation', 'Someone else corrected this memory first…', {
    details: { sqlstate: '23505', reason: 'memory_already_corrected', correction: CORRECTION },
  });
}

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('reading the refusal', () => {
  it('recognises it only by what the node actually sent', () => {
    expect(alreadyCorrectedRefusal(refusal())).toEqual({ correction: CORRECTION });
  });

  it('is not fooled by a different refusal, a missing quote, or a plain object', () => {
    expect(alreadyCorrectedRefusal(new CollabError('invariant_violation', 'x', {
      details: { reason: 'project_not_linked' },
    }))).toBeNull();
    // The reason with no words behind it is not enough: the notice exists to
    // show the other correction, and an empty quote would render a sentence
    // whose point is missing.
    expect(alreadyCorrectedRefusal(new CollabError('invariant_violation', 'x', {
      details: { reason: 'memory_already_corrected', correction: '   ' },
    }))).toBeNull();
    expect(alreadyCorrectedRefusal(new Error('boom'))).toBeNull();
    expect(alreadyCorrectedRefusal(null)).toBeNull();
  });
});

describe('what it says', () => {
  it('quotes the other correction in full and names no identifier', () => {
    const { title, body } = alreadyCorrectedNotice({ correction: CORRECTION }, true);
    expect(title.toLowerCase()).toContain('corrected this memory first');
    expect(body).toContain(CORRECTION);
    expect(`${title}\n${body}`).not.toMatch(UUID_ANYWHERE);
  });

  it('says where the words the person typed went, so nobody retypes them', () => {
    const saved = alreadyCorrectedNotice({ correction: CORRECTION }, true).body;
    expect(saved).toContain('was saved');
    expect(saved).toContain('do not need to write it again');
    // And says nothing of the sort when there was nothing saved to reassure
    // them about — a false reassurance is worse than none.
    const unsaved = alreadyCorrectedNotice({ correction: CORRECTION }, false).body;
    expect(unsaved).not.toContain('do not need to write it again');
  });

  it('names the move that works instead of telling them to try again', () => {
    const { body } = alreadyCorrectedNotice({ correction: CORRECTION }, true);
    expect(body).toMatch(/correct THEIR version/);
    expect(body.toLowerCase()).not.toContain('try again');
    expect(body.toLowerCase()).not.toContain('retry');
  });

  it('uses no developer vocabulary a non-developer would have to look up', () => {
    const { title, body } = alreadyCorrectedNotice({ correction: CORRECTION }, true);
    const copy = `${title} ${body}`.toLowerCase();
    for (const jargon of [
      'supersede', 'edge', 'unique', 'constraint', 'index', 'sqlstate', '23505',
      'append-only', 'invariant', 'props', 'schema', 'null', 'transaction', '056',
    ]) {
      expect(copy, `user-facing copy must not say “${jargon}”`).not.toContain(jargon);
    }
  });
});

describe('the mark flow reaches for it', () => {
  const TARGET = { id: 'mem-old' as EntityId, version: 3, title: 'the old claim' };

  function harness(createEdgeError: unknown) {
    const onError = vi.fn();
    const commands = {
      createEntity: vi.fn(async () => ({ entity: { id: 'mem-new' }, patches: [] })),
      createEdge: vi.fn(async () => { throw createEdgeError; }),
    } as never;
    const hook = renderHook(() => useMemoryMarks({
      spaceId: 'sp-1' as SpaceId,
      target: TARGET,
      memberKind: 'memory' as CreatableEntityKind,
      commands,
      onChanged: vi.fn(),
      onError,
    }));
    act(() => { hook.result.current.begin?.('supersede'); });
    act(() => {
      for (const [key, value] of Object.entries({
        statement: 'The nightly sweep runs at 03:00 UTC.',
        mechanism: 'read the timer unit on the box',
        subjectScope: 'this deployment',
        doesNotEstablish: 'anything about other deployments',
        reason: 'the old time is wrong',
      })) hook.result.current.composer.set(key, value);
    });
    act(() => { hook.result.current.composer.submit(); });
    return { onError };
  }

  it('shows the other correction rather than the database error', async () => {
    const { onError } = harness(refusal());
    await waitFor(() => expect(onError).toHaveBeenCalled());
    const [title, body] = onError.mock.calls[0] as [string, string];
    expect(title).toContain('corrected this memory first');
    expect(body).toContain(CORRECTION);
    expect(body).not.toContain('23505');
  });

  it('leaves every other failure on the faithful pass-through', async () => {
    const { onError } = harness(new Error('the node went away'));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    const [title, body] = onError.mock.calls[0] as [string, string];
    expect(title).toContain('link to the old one was not');
    expect(body).toContain('the node went away');
  });
});
