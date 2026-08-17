// @vitest-environment jsdom
/**
 * THE MENU SECTION'S LAYOUT, asserted — the menu lane's half of
 * SECTION-CONTRACT.md.
 *
 * jsdom has no layout engine, so nothing here can assert a pixel. The pixels
 * were measured in real Chrome per §8 and are recorded in the PR; what this
 * file holds is the STRUCTURE those measurements came from, because structure
 * is what regresses when the next person edits this component.
 *
 * Two of the four facts below are about the stylesheet rather than the DOM.
 * That is deliberate and it is the same reasoning `section-frame.test.tsx`
 * gives for its own gap: §3's "a bounded pane, never `flex: 1`" is a fact that
 * lives in CSS, jsdom will never evaluate it, and a rule nothing asserts is a
 * rule that comes back. Reading the source is a weaker test than measuring the
 * box — it is a much stronger test than not having one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { resolveMenu } from '../shell/menu-resolve';
import { MenuEditor } from './MenuEditor';
import { SectionFrame } from './SectionFrame';

afterEach(cleanup);

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, 'menu-editor.css'), 'utf8');

/** The declarations inside one rule block of my stylesheet, whitespace-collapsed. */
function ruleFor(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `menu-editor.css declares no rule for \`${selector}\``).toBeGreaterThan(-1);
  return CSS.slice(at, CSS.indexOf('}', at)).replace(/\s+/g, ' ');
}

const MENU = resolveMenu(null);

/** What `SettingsShell` actually renders around this component. */
function inFrame(node: React.ReactElement) {
  return render(
    <SectionFrame title="Menu" measure={false} bodyTestId="menu-body">
      {node}
    </SectionFrame>,
  );
}

describe('the menu section is laid out to the section contract', () => {
  it('draws ONE head — the frame’s — not a second one of its own', () => {
    /* The shell wraps this component in a `SectionFrame` whose head reads
       "Menu" at 19px serif, and this component used to draw its own
       `.set-menu__head` reading "Menu" at 16px serif directly underneath it.
       Two headings, one section. */
    const { container } = inFrame(<MenuEditor menu={MENU} spaceName="atelier" />);
    expect(container.querySelectorAll('.set-section__head')).toHaveLength(1);
    expect(container.querySelector('.set-menu__head')).toBeNull();
    expect(container.querySelector('.set-menu__title')).toBeNull();
  });

  it('has no third column reserving width for states that are usually absent', () => {
    /* `.set-menu__states` was `flex: 1 1 280px` and rendered whether or not it
       had anything in it: measured 883x0 at 1508x882 (an empty element that had
       wrapped onto its own line) and 433x387 at 900x600 — a third of the card
       held empty on the size where width was scarcest. */
    const { container } = inFrame(<MenuEditor menu={MENU} spaceName="atelier" />);
    expect(container.querySelector('.set-menu__states')).toBeNull();
    expect(container.querySelector('.set-menu__alerts')).toBeNull();
  });

  it('puts conflict, lock and issue ABOVE the editor/preview split', () => {
    const { container } = inFrame(
      <MenuEditor
        menu={MENU}
        spaceName="atelier"
        conflictRevision={MENU.config.revision + 1}
        versionLocked
      />,
    );
    const alerts = container.querySelector('.set-menu__alerts');
    const cols = container.querySelector('.set-menu__cols');
    expect(alerts).not.toBeNull();
    expect(cols).not.toBeNull();
    expect(alerts!.contains(screen.getByTestId('menu-conflict'))).toBe(true);
    expect(alerts!.contains(screen.getByTestId('menu-version-lock'))).toBe(true);
    // DOCUMENT_POSITION_FOLLOWING: the split comes after the alerts.
    expect(alerts!.compareDocumentPosition(cols!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('refuses Save exactly once under a version lock', () => {
    /* The lock banner used to draw its own second "Save menu" beside the head's,
       so a locked editor refused one verb twice. */
    inFrame(<MenuEditor menu={MENU} spaceName="atelier" versionLocked />);
    expect(screen.getAllByRole('button', { name: /^save menu/ })).toHaveLength(1);
  });

  it('states an empty menu instead of drawing two blank panes', () => {
    /* `resolveMenu` can never HAND us an empty menu — `isRenderableMenu`
       rejects a config with no groups and it falls back to the shipped default.
       So the empty state is reachable only by editing down to it, which is
       exactly how a person reaches it, and driving it that way proves the state
       is real rather than merely constructible in a test. */
    inFrame(<MenuEditor menu={MENU} spaceName="atelier" />);
    expect(screen.queryByTestId('menu-empty')).toBeNull();

    for (const btn of screen.getAllByRole('button', { name: /^remove group / })) {
      fireEvent.click(btn);
    }

    // §7.4 — the absent state is a real SectionAbsent, in the editor AND in the
    // preview, because a blank preview reads as "the preview is broken".
    expect(screen.getByTestId('menu-empty').textContent).toMatch(/no groups/i);
    expect(screen.getByTestId('menu-preview-empty')).toBeTruthy();
  });

  describe('§3 — one scroller for the section, one BOUNDED pane inside it', () => {
    it('bounds the preview with a height of its own, never `flex: 1`', () => {
      const preview = ruleFor('.set-menu .set-menu__preview');
      expect(preview).toMatch(/max-height:/);
      expect(preview).not.toMatch(/flex: 1/);

      const body = ruleFor('.set-menu .set-prev__body');
      expect(body).toMatch(/overflow: auto/);
    });

    it('leaves the editor’s rows to the section scroller', () => {
      /* `.set-menu__rows` was `flex: 1; overflow: auto` — a second scroller
         nested inside `.set-section__scroll`, which is the exact pair §3 names:
         the outer one takes the overflow and the inner one clips instead. */
      expect(ruleFor('.set-menu .set-menu__rows')).toMatch(/overflow: visible/);
    });
  });

  it('gives the drag grips a real hit area', () => {
    /* Measured at 8x11 CSS px in Chrome before this change — smaller than the
       glyph's own em box, on the surface whose whole job is dragging. */
    const grip = ruleFor('.set-menu .set-grip');
    expect(grip).toMatch(/width: 24px/);
    expect(grip).toMatch(/height: 24px/);
  });
});
