// @vitest-environment jsdom
/**
 * THE EMPTY CATALOG — its own file because it needs `LAUNCH_MODEL_CATALOG`
 * mocked at module scope, and `models-section.test.tsx` needs the real one.
 *
 * Before 2026-08-16 an empty catalog did not render an absence at all: it
 * rendered one heading per KNOWN tool, each with "No models are offered for
 * this tool" under it — i.e. two confident group headings asserting the
 * existence of two groups that had nothing in them, and no statement anywhere
 * that the launch picker was about to be empty. §7.4 wants a real
 * `SectionAbsent`.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@tm8/contract', async () => {
  const real = await vi.importActual<Record<string, unknown>>('@tm8/contract');
  return { ...real, LAUNCH_MODEL_CATALOG: [] };
});

afterEach(cleanup);

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

it('an empty catalog is a stated ABSENCE, not two empty group headings', async () => {
  const { ModelsSection } = await import('./ModelsSection');
  render(<ModelsSection nodeKey="local" heading="Models" />);

  const absent = screen.getByTestId('models-absent');
  expect(absent.textContent).toMatch(/no models at all/i);
  // It says the CONSEQUENCE — the picker will have nothing to offer — rather
  // than only the fact.
  expect(absent.textContent).toMatch(/launch picker will have nothing to offer/i);

  // No group heading claims a group that does not exist.
  expect(screen.queryByTestId('models-group-claude-code')).toBeNull();
  expect(screen.queryByTestId('models-group-codex')).toBeNull();

  // The way OUT of the empty state is still on screen.
  expect(screen.getByTestId('models-add-form')).toBeTruthy();
  // And the scope statement still leads, because it governs the add below it.
  expect(screen.getByTestId('models-scope')).toBeTruthy();
});
