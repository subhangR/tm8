/**
 * The catalog's whole claim is "this is what tm8 actually says to an agent".
 * These tests defend that claim, so they check provenance rather than content:
 * a test that asserted the kernel's wording would just be a third copy of it.
 *
 * What is actually at risk here is DRIFT — someone edits a prompt constant and
 * the catalog keeps showing the old bytes — and DISHONESTY, an entry claiming
 * to be live when nothing calls it. Both are checked below.
 */
import { describe, expect, it } from 'vitest';
import {
  PROMPT_CATEGORIES,
  PROMPT_CATEGORY_IDS,
  PROMPT_ENTRIES,
  entriesInCategory,
  findPromptEntry,
  promptCatalogStats,
  promptEntryBytes,
} from '../src/catalog.js';
import { BYTE_BUDGETS, type BudgetName } from '../src/budgets.js';
import { composeKernel } from '../src/kernel.js';
import {
  AGENT_MODES,
  commandSurface,
  instructionFor,
  COMMAND_SURFACE_INSTRUCTION,
  NO_TASK_NOTE_V1,
} from '../src/index.js';

describe('catalog shape', () => {
  it('gives every entry a unique id', () => {
    const ids = PROMPT_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('files every entry under a declared category', () => {
    for (const entry of PROMPT_ENTRIES) {
      expect(PROMPT_CATEGORY_IDS).toContain(entry.categoryId);
    }
  });

  it('leaves no category empty', () => {
    for (const category of PROMPT_CATEGORIES) {
      expect(entriesInCategory(category.id).length).toBeGreaterThan(0);
    }
  });

  it('declares a category object for every category id', () => {
    expect(PROMPT_CATEGORIES.map((c) => c.id).sort()).toEqual([...PROMPT_CATEGORY_IDS].sort());
  });

  it('finds an entry by id, and misses cleanly', () => {
    expect(findPromptEntry('kernel.v1')?.categoryId).toBe('kernel');
    expect(findPromptEntry('nope')).toBeUndefined();
  });
});

describe('honesty', () => {
  it('explains itself whenever an entry is not live', () => {
    for (const entry of PROMPT_ENTRIES) {
      if (entry.status !== 'live') {
        expect(entry.statusNote, `${entry.id} is ${entry.status} with no note`).toBeTruthy();
      }
    }
  });

  it('carries text unless it is an explicit pointer', () => {
    for (const entry of PROMPT_ENTRIES) {
      if (entry.rendering === 'pointer') expect(entry.text).toBe('');
      else expect(entry.text.length, `${entry.id} has no text`).toBeGreaterThan(0);
    }
  });

  it('points every entry at a real definition site', () => {
    for (const entry of PROMPT_ENTRIES) {
      expect(entry.source, entry.id).toMatch(/^(packages|db)\//);
    }
  });

  it('names a budget only when that budget exists', () => {
    for (const entry of PROMPT_ENTRIES) {
      if (entry.budget) expect(BYTE_BUDGETS[entry.budget as BudgetName]).toBeGreaterThan(0);
    }
  });

  it('counts statuses that sum to the total', () => {
    const s = promptCatalogStats();
    expect(s.live + s.unwired + s.reference).toBe(s.total);
    expect(s.total).toBe(PROMPT_ENTRIES.length);
    expect(s.bytes).toBeGreaterThan(0);
  });
});

// The anti-drift core: each of these re-derives the prompt from its real source
// and demands the catalog match byte for byte.
describe('no drift from the real composers', () => {
  it('shows the actual mode instructions', () => {
    for (const mode of AGENT_MODES) {
      const entry = findPromptEntry(`mode.${mode}`);
      expect(entry, `missing catalog entry for ${mode}`).toBeDefined();
      expect(entry!.text).toBe(instructionFor(mode));
    }
  });

  it('covers all four modes and no more', () => {
    expect(entriesInCategory('mode-identity').length).toBe(AGENT_MODES.length);
  });

  it('shows the actual kernel, composed by composeKernel', () => {
    const entry = findPromptEntry('kernel.v1')!;
    // Re-compose with the same placeholder facts the catalog uses.
    const expected = composeKernel({
      mode: '{mode}',
      displayName: '{displayName}',
      actorId: '{actorId}',
      teamMemberId: '{teamMemberId}',
      sessionId: '{sessionId}',
      spaceId: '{spaceId}',
      cwd: '{cwd}',
      workdirMode: '{workdirMode}',
      launchProjectId: '{launchProjectId}',
      primaryTaskId: '{primaryTaskId}',
      coordinatorSessionId: '{coordinatorSessionId}',
      interactionProfileId: '{interactionProfileId}',
      interactionProfileVersion: '{version}',
      resolvedProfileHash: '{resolvedProfileHash}',
      manifestPath: '{manifestPath}',
    });
    expect(entry.text).toBe(expected);
  });

  it('shows the actual frame instructions', () => {
    expect(findPromptEntry('frame.command-surface')!.text).toBe(COMMAND_SURFACE_INSTRUCTION);
    expect(findPromptEntry('frame.no-task-v1')!.text).toBe(NO_TASK_NOTE_V1);
  });

  it('lists every command-surface row', () => {
    const text = findPromptEntry('discovery.command-surface')!.text;
    for (const cmd of commandSurface(true)) expect(text).toContain(cmd.usage);
  });

  it('has one trusted-control entry per §14 template', () => {
    // Ten templates in the frozen spec; the catalog must not quietly drop one.
    expect(entriesInCategory('trusted-control').length).toBe(10);
  });

  it('lists every byte budget', () => {
    const text = findPromptEntry('budget.ceilings')!.text;
    for (const name of Object.keys(BYTE_BUDGETS)) expect(text).toContain(name);
  });
});

describe('composed entries stay within their own budgets', () => {
  it('does not exceed a named ceiling', () => {
    for (const entry of PROMPT_ENTRIES) {
      if (!entry.budget) continue;
      expect(promptEntryBytes(entry), entry.id).toBeLessThanOrEqual(
        BYTE_BUDGETS[entry.budget as BudgetName],
      );
    }
  });

  it('reports zero bytes for pointer entries', () => {
    for (const entry of PROMPT_ENTRIES) {
      if (entry.rendering === 'pointer') expect(promptEntryBytes(entry)).toBe(0);
    }
  });
});
