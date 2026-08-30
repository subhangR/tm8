// @vitest-environment jsdom
/**
 * WHAT THE ROOT HEADER'S ＋ PROMISES MUST BE WHAT IT DOES.
 *
 * THE MISS THIS RECORDS. Wiring the Files ＋ to the staged upload flow
 * (Tarkesh bug 01a04730) made the BUTTON correct and left its title saying
 * "Create an Untitled file and open it — type its name there". Every unit
 * assertion in the package still passed. The lie was only visible by reading
 * the rendered attribute in a browser, which is where it was in fact caught —
 * a screenshot run printed the title beside the click that opened a file
 * picker, and the two did not agree.
 *
 * A control that does one thing and promises another is the same defect class
 * as a live button that does nothing: the viewer is told something false about
 * what pressing it will cost them. `ListRootHeader` already refuses the second
 * (a refused ＋ renders disabled WITH ITS REASON rather than hidden); this is
 * the first, asserted rather than left to the next screenshot.
 *
 * EVERYTHING HERE IS REGISTRY-DRIVEN. The kinds come from `allKinds()`, split
 * by what their rows declare — no kind is named, so a new kind that declares a
 * `createForm` is covered the day it lands.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ListRootHeader } from './ListRootHeader';
import { allKinds, type KindConfig } from '../domain';

function optionFor(config: KindConfig) {
  return { kind: config.kind, label: config.labelPlural, single: config.label };
}

function renderHeaderFor(config: KindConfig) {
  return render(
    <ListRootHeader
      rootsLabel="Roots"
      cell={optionFor(config)}
      cellActive
      onSelectCell={() => undefined}
      onCreate={() => undefined}
      onPickKind={() => undefined}
    />,
  );
}

/** The ＋ half of the kind cell, whatever it is labelled. */
function plusOf(view: ReturnType<typeof render>): HTMLElement {
  const button = view.container.querySelector('.tch-rootcell--kind .tch-rootcell__plus');
  expect(button, 'the kind cell always draws a ＋ half').toBeTruthy();
  return button as HTMLElement;
}

const staged = allKinds().filter((k) => k.createForm !== undefined);
const started = allKinds().filter((k) => k.list.quickStart !== undefined);
const immediate = allKinds().filter(
  (k) => k.createForm === undefined && k.list.quickStart === undefined && k.list.quickCreate,
);

describe('a kind whose content must exist before the entity does', () => {
  it('has at least one such kind (a guard over an empty set proves nothing)', () => {
    expect(staged.length).toBeGreaterThan(0);
  });

  it('never promises the immediate create it does not run', () => {
    for (const config of staged) {
      const view = renderHeaderFor(config);
      const title = plusOf(view).getAttribute('title') ?? '';
      // The exact words of the immediate flow's promise. Its ＋ commits an
      // entity on press and the SAVE flow names it; a staged kind's ＋ does
      // neither, so neither half of that sentence may appear.
      expect(title, `${config.kind}: the staged ＋ promises the immediate create`)
        .not.toMatch(/Untitled/i);
      expect(title, `${config.kind}: the staged ＋ promises an inline rename`)
        .not.toMatch(/type its name/i);
      view.unmount();
    }
  });

  it('says the entity is made only once its content exists', () => {
    for (const config of staged) {
      const view = renderHeaderFor(config);
      expect(plusOf(view).getAttribute('title') ?? '').toMatch(/once its content exists/i);
      view.unmount();
    }
  });

  it('wears the label its own palette gives the act, so header and panel agree', () => {
    for (const config of staged) {
      const view = renderHeaderFor(config);
      const expected = config.palette?.createLabel ?? `New ${config.label.toLowerCase()}`;
      expect(plusOf(view).getAttribute('aria-label')).toBe(expected);
      view.unmount();
    }
  });
});

describe('the other two births keep their own promises', () => {
  it('a STARTED kind still says it starts one', () => {
    expect(started.length).toBeGreaterThan(0);
    for (const config of started) {
      const view = renderHeaderFor(config);
      expect(plusOf(view).getAttribute('title') ?? '').toMatch(/started, not authored/i);
      view.unmount();
    }
  });

  it('an ordinary kind still promises the immediate create', () => {
    expect(immediate.length).toBeGreaterThan(0);
    for (const config of immediate) {
      const view = renderHeaderFor(config);
      const title = plusOf(view).getAttribute('title') ?? '';
      expect(title, `${config.kind}`).toMatch(/Untitled/i);
      expect(title, `${config.kind}`).toMatch(/type its name/i);
      view.unmount();
    }
  });

  it('the three arms are disjoint, so no kind is answered twice', () => {
    // `birthVerbFor` asks in order — started, then staged, then immediate — so
    // a kind in two sets would silently take the first and the second would
    // read as dead code. Stated as data rather than trusted to the ordering.
    for (const config of staged) {
      expect(config.list.quickStart, `${config.kind} is both started and staged`).toBeUndefined();
    }
  });
});
