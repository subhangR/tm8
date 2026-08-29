// @vitest-environment jsdom
/**
 * The Models section — the first surface in this module whose writes all land.
 *
 * What is asserted here is mostly about HONESTY OF SCOPE and HONESTY OF VERB:
 * the section is browser-local and must say so, and "hide" and "delete" must
 * not be conflated, because a viewer who believes a built-in was deleted will
 * be surprised by the next contract update rather than by this screen.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ModelsSection } from './ModelsSection';
import { modelCatalog } from '../domain/model-catalog';
import { modelsFor } from '../domain/launch';

afterEach(cleanup);

beforeEach(() => {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    },
  });
});

const renderSection = () => render(<ModelsSection nodeKey="local" heading="Models" />);

it('states its real scope — per browser, not space-wide', () => {
  renderSection();
  const scope = screen.getByTestId('models-scope').textContent ?? '';
  expect(scope).toMatch(/THIS BROWSER/i);
  expect(scope).toMatch(/not shared/i);
});

it('lists the built-ins grouped by agent tool', () => {
  renderSection();
  expect(within(screen.getByTestId('models-group-claude-code')).getByText('claude-opus-5')).toBeTruthy();
  expect(within(screen.getByTestId('models-group-codex')).getByText('gpt-5.6-sol')).toBeTruthy();
});

it('adds a model and it appears in the list AND in the launch picker', () => {
  renderSection();
  fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'my-new-model' } });
  fireEvent.change(screen.getByLabelText('Display label'), { target: { value: 'My New Model' } });
  fireEvent.click(screen.getByTestId('models-add-submit'));

  expect(screen.getByTestId('model-row-my-new-model')).toBeTruthy();
  // The point of the screen: it reaches the thing that launches.
  expect(modelsFor('claude-code').map((m) => m.id)).toContain('my-new-model');
});

it('refuses an incomplete add WITH THE REASON on screen', () => {
  renderSection();
  fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'x' } });
  fireEvent.click(screen.getByTestId('models-add-submit'));
  expect(screen.getByTestId('models-refusal').textContent).toMatch(/label is required/i);
});

it('HIDES a built-in — the row stays, marked, with a way back', () => {
  renderSection();
  fireEvent.click(screen.getByLabelText('Hide Claude Opus 5'));

  // Still rendered (so it can be restored), but marked and out of the picker.
  const row = screen.getByTestId('model-row-claude-opus-5');
  expect(row.getAttribute('data-hidden')).toBe('true');
  expect(within(row).getByText('hidden')).toBeTruthy();
  expect(modelsFor('claude-code').map((m) => m.id)).not.toContain('claude-opus-5');

  fireEvent.click(screen.getByLabelText('Reset Claude Opus 5'));
  expect(modelsFor('claude-code').map((m) => m.id)).toContain('claude-opus-5');
});

it('offers DELETE for a custom model and HIDE for a built-in — never the same word', () => {
  renderSection();
  fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'mine-1' } });
  fireEvent.change(screen.getByLabelText('Display label'), { target: { value: 'Mine One' } });
  fireEvent.click(screen.getByTestId('models-add-submit'));

  expect(screen.getByLabelText('Delete Mine One')).toBeTruthy();
  expect(screen.queryByLabelText('Hide Mine One')).toBeNull();
  expect(screen.getByLabelText('Hide Claude Opus 5')).toBeTruthy();
  expect(screen.queryByLabelText('Delete Claude Opus 5')).toBeNull();

  fireEvent.click(screen.getByLabelText('Delete Mine One'));
  expect(screen.queryByTestId('model-row-mine-1')).toBeNull();
});

it('edits a label and marks the built-in as edited', () => {
  renderSection();
  fireEvent.click(screen.getByLabelText('Edit Claude Opus 5'));
  fireEvent.change(screen.getByLabelText('Label for claude-opus-5'), { target: { value: 'Opus (mine)' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  const row = screen.getByTestId('model-row-claude-opus-5');
  expect(within(row).getByText('Opus (mine)')).toBeTruthy();
  expect(within(row).getByText('edited')).toBeTruthy();
  expect(modelsFor('claude-code').find((m) => m.id === 'claude-opus-5')?.label).toBe('Opus (mine)');
});

it('reset-all appears only once there is something to reset, and clears everything', () => {
  renderSection();
  expect(screen.queryByTestId('models-reset-all')).toBeNull();

  fireEvent.click(screen.getByLabelText('Hide Claude Opus 5'));
  fireEvent.click(screen.getByTestId('models-reset-all'));

  expect(screen.queryByTestId('models-reset-all')).toBeNull();
  expect(modelCatalog('local')).toHaveLength(modelCatalog('local', true).length);
});

/* ---------------------------------------------------------------------------
   LAYOUT — SECTION-CONTRACT.md, 2026-08-16.

   These hold the three things the frame pass could not fix from outside the
   section: that it stopped hand-rolling the frame, that it stopped drawing its
   list rows with the class the settings CARD is drawn with, and that a reader
   can tell WHICH node's catalog they are editing. jsdom loads no stylesheet, so
   nothing here asserts a pixel — the geometry was measured in real Chrome (§8);
   these assert the STRUCTURE those measurements depend on, which is the part a
   future edit can silently undo.
   ------------------------------------------------------------------------ */

it('is built on SectionFrame and owns exactly ONE scroller', () => {
  const { container } = renderSection();

  // The frame's three parts, rendered by SectionFrame rather than transcribed.
  expect(container.querySelectorAll('.set-section')).toHaveLength(1);
  expect(container.querySelectorAll('.set-section__head')).toHaveLength(1);

  // §3: two nested scrollers means the inner one gets no overflow to
  // distribute and its content is clipped instead of scrolling.
  expect(container.querySelectorAll('.set-section__scroll')).toHaveLength(1);

  // And the body is at the reading measure with the standard gutters, not an
  // inline `style={{ padding: 16 }}` disagreeing with the head above it.
  const measure = container.querySelector('.set-section__measure');
  expect(measure).toBeTruthy();
  expect(measure?.classList.contains('set-section__pad')).toBe(true);
  expect(container.querySelector('.set-section__scroll')?.getAttribute('style')).toBeNull();
});

it('draws list rows with its OWN class, never `.set-card`', () => {
  const { container } = renderSection();

  /* `.set-card` is the class the whole settings card is drawn with. The frame
     pass gave it `flex: 1`, `max-width: 1080px` and `margin-inline: auto`; a
     list row carrying page-card geometry is a collision waiting for the next
     frame change. It is also `display: flex` with the initial
     `align-items: stretch`, which is what stretched an 11px `custom` pill to
     72px beside a model id that wrapped to five lines. */
  expect(container.querySelectorAll('.set-card')).toHaveLength(0);
  expect(container.querySelectorAll('.set-models__row').length).toBeGreaterThan(0);

  const row = screen.getByTestId('model-row-claude-opus-5');
  expect(row.classList.contains('set-models__row')).toBe(true);
  // The id is the machine string and gets the mono slot; the human label does
  // not — it was in `.set-kv__k`, a 96px uppercase FIELD-NAME slot.
  expect(row.querySelector('.set-models__id')?.textContent).toBe('claude-opus-5');
  expect(row.querySelector('.set-models__label')?.textContent).toBe('Claude Opus 5');
  expect(row.querySelector('.set-kv__k')).toBeNull();
});

it('SAYS which node the catalog belongs to, and flags a named server', () => {
  // The key was passed in and rendered nowhere: two nodes' catalogs looked
  // identical on screen.
  renderSection();
  expect(screen.getByTestId('models-node').textContent).toMatch(/\blocal\b/);
  expect(screen.getByTestId('models-node').textContent).not.toMatch(/named server/);
  cleanup();

  render(<ModelsSection nodeKey="https://tm8.example.dev:7778" heading="Models" />);
  const node = screen.getByTestId('models-node').textContent ?? '';
  expect(node).toMatch(/https:\/\/tm8\.example\.dev:7778/);
  expect(node).toMatch(/named server/);
});

it('names an UNRECOGNISED agent tool instead of heaping it under "other"', () => {
  renderSection();
  fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'gemini-3-pro' } });
  fireEvent.change(screen.getByLabelText('Display label'), { target: { value: 'Gemini 3 Pro' } });
  fireEvent.click(screen.getByTestId('models-add-submit'));
  // The add form only offers KNOWN tools, so reach the unknown path the way a
  // stale localStorage delta does: written directly.
  cleanup();
  const key = [...Array(localStorage.length).keys()].map((i) => localStorage.key(i)!)[0];
  const delta = JSON.parse(localStorage.getItem(key)!);
  delta.custom[0].agentTool = 'gemini-cli';
  localStorage.setItem(key, JSON.stringify(delta));

  renderSection();
  const group = screen.getByTestId('models-group-gemini-cli');
  expect(within(group).getByText('gemini-cli')).toBeTruthy();
  // And it says plainly that this UI cannot build its command line.
  expect(group.textContent).toMatch(/does not know how to build a launch command/i);
  // The row is still offerable and still listed — omitting it would make this
  // screen and the launch picker disagree about the same catalog.
  expect(within(group).getByTestId('model-row-gemini-3-pro')).toBeTruthy();
});
