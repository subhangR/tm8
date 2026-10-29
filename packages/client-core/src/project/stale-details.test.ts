/**
 * STALE CONTENT IS RECORDED, NOT SILENTLY MERGED.
 *
 * === WHAT WAS BROKEN ===
 *
 * An `entity.upsert` carries an `EntitySummary` and NO content. Both merge
 * paths overlay it on the cached detail to keep the heavy sections:
 *
 *   details[id] = { ...detail, ...summary }      // reduceEntityEvent, ingestSummaries
 *
 * That is right for `title`, `state` and `counters`, and wrong for `content`.
 * The record ends up CLAIMING the new version while holding the previous
 * read's body, scene or bundle — and every consumer downstream is written to
 * trust the version. Nothing re-read on an incoming bump (`refetchDetail` runs
 * only after the viewer's own actions, `pull` early-returns on a cached
 * detail), so an open doc, drawing or artifact sat on old content until the
 * page was reloaded. QA measured the drawing case: v14 arrived with v13's
 * scene, and the yellow v14 was never drawn.
 *
 * === WHAT THESE TESTS PIN ===
 *
 * The MARK, which is the half that makes the fix possible at all. Its rules
 * are small and each one is load-bearing:
 *
 *  1. A newer version over a cached detail records the ANNOUNCED version.
 *  2. The content really is still the old one — this suite asserts the bug it
 *     is compensating for, so nobody later "fixes" it by deleting the mark.
 *  3. No cached detail ⇒ no mark (nothing to be stale; `pull` fills that).
 *  4. Same or older version ⇒ no mark (no new content was announced).
 *  5. A read at or past the mark CLEARS it; a read short of it does NOT, so a
 *     node answering behind its own announcement is not recorded as current.
 *  6. A burst leaves ONE mark naming the newest version — the coalescing the
 *     consumer's one-read-per-bump rule depends on.
 *  7. A mark never outlives the detail it describes (deletion, eviction).
 */
import { describe, expect, it } from 'vitest';
import type { DurableWorkspaceEvent } from '@tm8/contract';
import {
  DETAIL_CACHE_CAP,
  type DomainState,
  ingestDetail,
  ingestSummaries,
  initialDomainState,
  reduceEvent,
  reduceEvents,
} from './reducers.js';
import { detail, event, summary } from './test-support.js';

function apply(state: DomainState, e: DurableWorkspaceEvent): DomainState {
  return { ...state, ...reduceEvent(state, e) };
}

/** A doc-shaped detail, so "the content changed" is a visible fact. */
function docDetail(id: string, version: number, body: string) {
  return detail(id, {
    version,
    kind: 'doc',
    content: { kind: 'doc', body, format: 'markdown' },
  } as never);
}

/** The cache an open panel has: one hydrated detail at v1. */
function withOpenDoc(id = 'doc_1', body = 'the original body'): DomainState {
  const base = initialDomainState();
  return { ...base, ...ingestDetail(base, docDetail(id, 1, body)) };
}

describe('entity.upsert records content it could not carry', () => {
  it('marks the announced version when a newer summary lands over a cached detail', () => {
    const state = withOpenDoc();
    const next = apply(state, event('entity.upsert', { entity: summary('doc_1', { version: 2, kind: 'doc' }) }));

    expect(next.staleDetails.doc_1).toBe(2);
  });

  it('the merged detail is genuinely still the OLD content — the bug being compensated', () => {
    const state = withOpenDoc('doc_1', 'the original body');
    const next = apply(state, event('entity.upsert', { entity: summary('doc_1', { version: 2, kind: 'doc' }) }));

    // The version moved and the body did not. If this ever stops being true the
    // merge was fixed at the source and the mark can go — but until then,
    // deleting the mark re-opens the stale-panel bug.
    expect(next.details.doc_1!.version).toBe(2);
    expect((next.details.doc_1!.content as { body: string }).body).toBe('the original body');
  });

  it('does NOT mark when no detail is cached — there is no content to be stale', () => {
    const base = initialDomainState();
    const next = apply(base, event('entity.upsert', { entity: summary('doc_1', { version: 9, kind: 'doc' }) }));

    expect(next.staleDetails.doc_1).toBeUndefined();
    expect(next.details.doc_1).toBeUndefined();
  });

  it('does NOT mark on the same version — a counter or activity bump announces no new content', () => {
    const state = withOpenDoc();
    const next = apply(state, event('entity.upsert', { entity: summary('doc_1', { version: 1, kind: 'doc' }) }));

    expect(next.staleDetails.doc_1).toBeUndefined();
  });

  it('does NOT mark on an older version — a late event never invalidates a newer read', () => {
    const base = initialDomainState();
    const state = { ...base, ...ingestDetail(base, docDetail('doc_1', 5, 'v5 body')) };
    const next = apply(state, event('entity.upsert', { entity: summary('doc_1', { version: 4, kind: 'doc' }) }));

    expect(next.staleDetails.doc_1).toBeUndefined();
  });

  it('a list read or command patch marks the same way the event path does', () => {
    // `ingestSummaries` carries the identical overlay, so a viewer who first
    // learns of the new version from a refreshed list is just as stale.
    const state = withOpenDoc();
    const next = { ...state, ...ingestSummaries(state, [summary('doc_1', { version: 3, kind: 'doc' })]) };

    expect(next.staleDetails.doc_1).toBe(3);
  });
});

describe('a landed read answers the mark', () => {
  it('a read AT the announced version clears it', () => {
    const state = withOpenDoc();
    const marked = apply(state, event('entity.upsert', { entity: summary('doc_1', { version: 2, kind: 'doc' }) }));
    expect(marked.staleDetails.doc_1).toBe(2);

    const read = { ...marked, ...ingestDetail(marked, docDetail('doc_1', 2, 'the NEW body')) };

    expect(read.staleDetails.doc_1).toBeUndefined();
    expect((read.details.doc_1!.content as { body: string }).body).toBe('the NEW body');
  });

  it('a read PAST the announced version clears it too', () => {
    const state = withOpenDoc();
    const marked = apply(state, event('entity.upsert', { entity: summary('doc_1', { version: 2, kind: 'doc' }) }));
    const read = { ...marked, ...ingestDetail(marked, docDetail('doc_1', 4, 'even newer')) };

    expect(read.staleDetails.doc_1).toBeUndefined();
  });

  it('a read SHORT of the announced version does not clear it', () => {
    /* A replica answering v2 against an announced v3 has not made this client
       current, and recording it as current would strand the panel one version
       behind with nothing left to say so.
       `ingestDetail`'s own guard refuses the whole v2 snapshot (a summary at
       v3 is cached, and overlaying it on v2 content is the very confusion this
       mark exists to track), so the content does not move either. Both halves
       stay honest: old content, and a mark that still says v3 is wanted. */
    const base = initialDomainState();
    const state = { ...base, ...ingestDetail(base, docDetail('doc_1', 1, 'v1')) };
    const marked = apply(state, event('entity.upsert', { entity: summary('doc_1', { version: 3, kind: 'doc' }) }));
    const read = { ...marked, ...ingestDetail(marked, docDetail('doc_1', 2, 'v2 body')) };

    expect(read.staleDetails.doc_1).toBe(3);
    expect((read.details.doc_1!.content as { body: string }).body).toBe('v1');
  });
});

describe('a burst leaves one mark, naming the newest version', () => {
  it('folds three bumps in one batch into a single announced version', () => {
    const state = withOpenDoc();
    const next = {
      ...state,
      ...reduceEvents(state, [
        event('entity.upsert', { entity: summary('doc_1', { version: 2, kind: 'doc' }) }),
        event('entity.upsert', { entity: summary('doc_1', { version: 3, kind: 'doc' }) }),
        event('entity.upsert', { entity: summary('doc_1', { version: 4, kind: 'doc' }) }),
      ]),
    };

    // One mark, at v4 — so the consumer issues ONE read, for the version that
    // is actually current, rather than one per event.
    expect(next.staleDetails.doc_1).toBe(4);
    expect(Object.keys(next.staleDetails)).toEqual(['doc_1']);
  });

  it('marks only the ids whose content this client actually holds', () => {
    const state = withOpenDoc();
    const next = {
      ...state,
      ...reduceEvents(state, [
        event('entity.upsert', { entity: summary('doc_1', { version: 2, kind: 'doc' }) }),
        // Nobody has this one open; it is a row in a list at most.
        event('entity.upsert', { entity: summary('doc_other', { version: 7, kind: 'doc' }) }),
      ]),
    };

    expect(Object.keys(next.staleDetails)).toEqual(['doc_1']);
  });
});

describe('a mark never outlives the detail it describes', () => {
  it('entity.deleted drops the mark with the content', () => {
    const state = withOpenDoc();
    const marked = apply(state, event('entity.upsert', { entity: summary('doc_1', { version: 2, kind: 'doc' }) }));
    const deleted = apply(
      marked,
      event('entity.deleted', { entity: summary('doc_1', { version: 3, kind: 'doc', deletedAt: '2026-10-18T00:00:00.000Z' }) }),
    );

    expect(deleted.details.doc_1).toBeUndefined();
    expect(deleted.staleDetails.doc_1).toBeUndefined();
  });

  it('a mark is pruned when the detail cache evicts the entry it describes', () => {
    const state = withOpenDoc();
    const marked = apply(state, event('entity.upsert', { entity: summary('doc_1', { version: 2, kind: 'doc' }) }));
    expect(marked.staleDetails.doc_1).toBe(2);

    // Browse past the cap. `doc_1` is the oldest entry, so it is the victim.
    let next = marked;
    for (let i = 0; i < DETAIL_CACHE_CAP + 1; i += 1) {
      next = { ...next, ...ingestDetail(next, docDetail(`other_${i}`, 1, 'body')) };
    }

    expect(next.details.doc_1, 'precondition: the detail was evicted').toBeUndefined();
    expect(next.staleDetails.doc_1).toBeUndefined();
  });

  it('leaves the slice identity alone when no mark changes', () => {
    /* `staleDetails` is a subscribed store slice. Returning a fresh object for
       an event that changed no mark would re-render every consumer below it on
       every event in a burst. */
    const state = withOpenDoc();
    const next = apply(state, event('entity.upsert', { entity: summary('doc_other', { version: 2, kind: 'doc' }) }));

    expect(next.staleDetails).toBe(state.staleDetails);
  });
});
