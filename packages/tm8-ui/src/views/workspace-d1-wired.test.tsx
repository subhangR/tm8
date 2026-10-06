/**
 * Spec D1 on the WORKSPACE page (owner, 6 Oct): every session-outcome surface —
 * tabs, rows, dividers, bulk actions, the Complete/Terminate dialogs and the
 * panel states — must be reachable from `WorkspaceView`. The tabs, rows,
 * dividers and grouping are rendered by `EntityListPanel` from the work_session
 * list config, and the panel states by `EntityDetailPanel`; what a HOST must
 * supply is the wiring, so this pins it at the source like
 * panel-primaries-wired.test.tsx does for the primaries.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { getKind } from '../domain';
import { SESSION_TABS } from '../domain/session-outcome';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, 'WorkspaceView.tsx'), 'utf8');

/** Every `<Tag … />` / `<Tag …>` opening element's props text, in order. */
function mounts(tag: string): string[] {
  const out: string[] = [];
  let at = SOURCE.indexOf(`<${tag}`);
  while (at >= 0) {
    let depth = 0;
    let i = at + 1;
    for (; i < SOURCE.length; i++) {
      const c = SOURCE[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push(SOURCE.slice(at, i));
    at = SOURCE.indexOf(`<${tag}`, i);
  }
  return out;
}

describe('Spec D1 is reachable on the workspace page', () => {
  it('the session list there gets the four session tabs (config-driven, default Running)', () => {
    const config = getKind('work_session').list;
    expect(config?.categories?.map((t) => t.id)).toEqual(SESSION_TABS.map((t) => t.id));
    expect(config?.defaultCategory).toBe('running');
    expect(SESSION_TABS.map((t) => t.label)).toEqual(['Running', 'Interrupted', 'Completed', 'Stopped']);
  });

  it('every list mount wires the row verbs, the bulk verbs and the claims', () => {
    const lists = mounts('EntityListPanel');
    expect(lists.length).toBeGreaterThan(0);
    for (const props of lists) {
      expect(props).toContain('onSessionVerb=');
      expect(props).toContain('onSessionBulk=');
      expect(props).toContain('linkedClaimsOf=');
      expect(props).toMatch(/onTerminate=|onAction=/);
      expect(props).toMatch(/onResume=|onAction=/);
    }
  });

  it('the detail panel wires the panel-state verbs and Mark lost', () => {
    const details = mounts('EntityDetailPanel');
    expect(details.length).toBeGreaterThan(0);
    for (const props of details) {
      expect(props).toContain('onSessionVerb=');
      expect(props).toContain('onMarkSessionExited=');
    }
    expect(SOURCE).toMatch(/onMarkSessionExited=\{\(\) => primaries\.sessionVerb\('mark-lost'/);
  });

  it('the page renders the Complete/Terminate dialogs and opts in to them', () => {
    expect(SOURCE).toContain('{primaries.dialog}');
    expect(SOURCE).toMatch(/usePanelPrimaries\(\{[\s\S]*?stateOf/);
  });
});
