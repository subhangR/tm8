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
