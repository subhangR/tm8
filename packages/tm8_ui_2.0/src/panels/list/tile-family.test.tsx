// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { getKind, type ActionContext, type QueryFilter } from '../../domain';
import type { EntitySummary } from '@tm8/contract';
import {
  FIXTURE_SPACE_ID,
  docLayoutSpec,
  prTransplant,
  sessionLive,
  spellDeploy,
  taskUuidTitle,
} from '../../fixtures';
import { EntityListPanel } from '../index';

/**
 * W3E — THE FAMILY ATTRIBUTE, on all three tile anatomies.
 *
 * Every tile root publishes `data-family={getKind(kind).graphFamily ?? 'gray'}`
 * so W3C's `[data-family]` accent rules (panels.css, W3C·5) have something to
 * key on. The EXPECTED value is read through `getKind` rather than naming a
 * colour, so a registry re-palette moves these tests with it and a tile that
 * hardcodes a family fails here.
 *
 * Kind literals are legal in tests (§15.2 scans shipped component code only);
 * the kinds below are the registry's exemplars of the three anatomies plus one
 * kind that declares NO family, for the gray fallback.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const rowsFor =
  (rows: readonly EntitySummary[]) =>
  (_filter: QueryFilter): readonly EntitySummary[] =>
    rows;

function firstTile(kind: string, row: EntitySummary): HTMLElement {
  // `usePanelChoice` persists the landing tab per kind in localStorage, which
  // jsdom shares across cases — clearing makes each render a first open.
  window.localStorage.clear();
  const { getAllByTestId } = render(
    <EntityListPanel kind={kind} rowsFor={rowsFor([row])} ctx={ctx} />,
  );
  return getAllByTestId('list-tile')[0]!;
}

describe('W3E — every anatomy root carries data-family from the registry', () => {
  const cases: Array<{ kind: string; row: EntitySummary; rootClass: string }> = [
    { kind: 'work_session', row: sessionLive, rootClass: 'pn-st' }, // session-tree
    { kind: 'task', row: taskUuidTitle, rootClass: 'pn-tt' }, // control-card
    { kind: 'doc', row: docLayoutSpec, rootClass: 'lp__tile' }, // standard
  ];

  for (const { kind, row, rootClass } of cases) {
    it(`${rootClass} (${kind}) publishes its registry family`, () => {
      // These registry rows DECLARE a family — a suite that only ever
      // exercised the gray fallback would pass with the attribute unwired.
      expect(getKind(kind).graphFamily, `${kind} should declare a graphFamily`).toBeDefined();
      const tile = firstTile(kind, row);
      expect(tile.classList.contains(rootClass), `anatomy root ${rootClass}`).toBe(true);
      expect(tile.getAttribute('data-family')).toBe(getKind(kind).graphFamily);
    });
  }

  it('a kind without a family falls back to gray, never to a missing attribute', () => {
    expect(getKind('spell').graphFamily, 'exemplar must really lack a family').toBeUndefined();
    expect(firstTile('spell', spellDeploy).getAttribute('data-family')).toBe('gray');
  });
});

describe('W3E — the standard tile draws the kind glyph', () => {
  it('a STATUSED standard row carries BOTH the kind glyph and its status dot', () => {
    // pull_request declares a `prState` status badge; before W3E the glyph was
    // the statusmark's FALLBACK, so exactly these rows lost their kind mark.
    const tile = firstTile('pull_request', prTransplant);
    const glyph = tile.querySelector('.lp__kindglyph svg');
    expect(glyph, 'KindIcon glyph').not.toBeNull();
    expect(glyph!.getAttribute('width')).toBe('14');
    expect(tile.querySelector('.lp__dot'), 'status dot still present').not.toBeNull();
  });

  it('a STATUSLESS standard row keeps exactly one glyph and no phantom dot', () => {
    const tile = firstTile('doc', docLayoutSpec);
    expect(tile.querySelectorAll('.lp__kindglyph').length).toBe(1);
    expect(tile.querySelector('.lp__dot')).toBeNull();
    // The existing title slot survives the structural change.
    expect(tile.querySelector('.lp__title')?.getAttribute('title')).toBe(docLayoutSpec.title);
  });
});
