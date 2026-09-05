// @vitest-environment jsdom
/**
 * The editable model catalog.
 *
 * The invariant worth defending is that ONLY THE DELTA IS STORED. If built-ins
 * were copied into localStorage, a contract update to a model's label — or a
 * NEW model shipped by the node — would be invisible behind a stale snapshot,
 * and "reset" would restore whatever happened to be captured rather than what
 * the node actually ships. That failure is silent and survives reloads.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';
import {
  addCustomModel,
  editModel,
  isModelHidden,
  localChangeCount,
  modelCatalog,
  removeModel,
  resetModel,
  resetModelCatalog,
  catalogModelsFor,
} from './model-catalog';
import { modelsFor } from './launch';

const NODE = 'local';

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

describe('defaults', () => {
  it('offers every built-in before anything is configured', () => {
    expect(modelCatalog(NODE).map((m) => m.model)).toEqual(LAUNCH_MODEL_CATALOG.map((e) => e.model));
    expect(localChangeCount(NODE)).toBe(0);
  });

  it('groups by agent tool the way the picker asks for them', () => {
    const codex = catalogModelsFor(NODE, 'codex').map((m) => m.model);
    expect(codex).toContain('gpt-5.6-sol');
    expect(codex).toContain('gpt-6-astra');
    expect(codex).not.toContain('claude-opus-5');
    expect(catalogModelsFor(NODE, null)).toEqual([]);
  });
});

describe('adding', () => {
  it('adds a model and offers it under its tool', () => {
    expect(addCustomModel(NODE, { model: 'my-model-1', label: 'My Model', agentTool: 'claude-code' })).toBeNull();
    const found = catalogModelsFor(NODE, 'claude-code').find((m) => m.model === 'my-model-1');
    expect(found).toMatchObject({ label: 'My Model', builtIn: false });
  });

  it('REACHES THE LAUNCH PICKER — the whole point of the screen', () => {
    // A settings page whose changes never arrive is the decorative-control
    // failure this codebase refuses everywhere else.
    expect(modelsFor('claude-code').map((m) => m.id)).not.toContain('my-model-2');
    addCustomModel(NODE, { model: 'my-model-2', label: 'Mine', agentTool: 'claude-code' });
    expect(modelsFor('claude-code').map((m) => m.id)).toContain('my-model-2');
  });

  it('refuses with a REASON, never a silent no-op', () => {
    expect(addCustomModel(NODE, { model: '  ', label: 'x', agentTool: 'claude-code' })).toMatch(/model id is required/i);
    expect(addCustomModel(NODE, { model: 'x', label: ' ', agentTool: 'claude-code' })).toMatch(/label is required/i);
    expect(addCustomModel(NODE, { model: 'claude-opus-5', label: 'dup', agentTool: 'claude-code' })).toMatch(/already a built-in/i);
    addCustomModel(NODE, { model: 'dup-1', label: 'a', agentTool: 'codex' });
    expect(addCustomModel(NODE, { model: 'dup-1', label: 'b', agentTool: 'codex' })).toMatch(/already been added/i);
  });
});

describe('editing and hiding built-ins', () => {
  it('applies a label edit and marks it overridden', () => {
    expect(editModel(NODE, 'claude-opus-5', { label: 'Opus (mine)' })).toBeNull();
    const row = modelCatalog(NODE).find((m) => m.model === 'claude-opus-5');
    expect(row).toMatchObject({ label: 'Opus (mine)', builtIn: true, overridden: true });
  });

  it('HIDES a built-in rather than deleting it, and reset restores it', () => {
    removeModel(NODE, 'claude-opus-5');
    expect(isModelHidden(NODE, 'claude-opus-5')).toBe(true);
    expect(modelCatalog(NODE).map((m) => m.model)).not.toContain('claude-opus-5');
    // still listed for the settings screen, which must offer to restore it
    expect(modelCatalog(NODE, true).map((m) => m.model)).toContain('claude-opus-5');
    resetModel(NODE, 'claude-opus-5');
    expect(modelCatalog(NODE).map((m) => m.model)).toContain('claude-opus-5');
  });

  it('DELETES a custom model for real', () => {
    addCustomModel(NODE, { model: 'gone', label: 'Gone', agentTool: 'codex' });
    expect(removeModel(NODE, 'gone')).toBeNull();
    expect(modelCatalog(NODE, true).map((m) => m.model)).not.toContain('gone');
  });
});

describe('only the delta is stored', () => {
  it('does not copy built-ins into storage', () => {
    editModel(NODE, 'claude-opus-5', { label: 'Renamed' });
    const raw = localStorage.getItem('tm8.model-catalog.v1.local') ?? '';
    expect(raw).toContain('Renamed');
    // the OTHER built-ins must not have been snapshotted
    expect(raw).not.toContain('claude-haiku-4-5-20251001');
    expect(raw).not.toContain('gpt-5.6-terra');
  });

  it('clears storage entirely when the last change is reset', () => {
    addCustomModel(NODE, { model: 'tmp', label: 'T', agentTool: 'codex' });
    editModel(NODE, 'claude-opus-5', { label: 'X' });
    expect(localChangeCount(NODE)).toBe(2);
    resetModelCatalog(NODE);
    expect(localStorage.getItem('tm8.model-catalog.v1.local')).toBeNull();
    expect(modelCatalog(NODE).map((m) => m.model)).toEqual(LAUNCH_MODEL_CATALOG.map((e) => e.model));
  });
});

describe('scoping and resilience', () => {
  it('keeps each node’s catalog separate', () => {
    addCustomModel(NODE, { model: 'local-only', label: 'L', agentTool: 'codex' });
    expect(modelCatalog('relay_prod').map((m) => m.model)).not.toContain('local-only');
  });

  it('falls back to the built-ins on a corrupt payload rather than throwing', () => {
    localStorage.setItem('tm8.model-catalog.v1.local', '{broken');
    expect(modelCatalog(NODE).map((m) => m.model)).toEqual(LAUNCH_MODEL_CATALOG.map((e) => e.model));
  });
});
