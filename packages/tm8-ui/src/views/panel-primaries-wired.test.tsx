import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allKinds, resolveAction } from '../domain';
import { PANEL_PRIMARY_ACTIONS } from './usePanelPrimaries';

/**
 * THE MOUNT-SITE GUARD — every `EntityDetailPanel` must be handed its verbs.
 *
 * WHAT WENT WRONG, and why a component test could not see it. `ActionBar`
 * renders a primary DISABLED-WITH-REASON when no handler is wired (R5 #9), and
 * `panels.test.tsx` asserts both halves of that rule correctly. It passes with
 * the app completely broken, because it renders the panel itself: the defect
 * was never in the panel, it was that NO HOST PASSED THE PROP. Five mount
 * sites, five dead action bars, and every unit test green — the registry had
 * declared `terminate` a session primary and derived `run` for every
 * `launchable` kind, and both rendered permanently greyed out in the shipped
 * app. That is the reported defect.
 *
 * So the assertion has to be about the WIRING, and the only place the wiring
 * is visible is the source of the hosts. This scans them.
 *
 * THE SAME SHAPE AS THE REGISTRY-INVARIANT GUARDS next door, for the same
 * reason: a verb that a registry row names and no host performs is a live
 * button that does nothing, and nobody remembers to check by hand when the
 * sixth screen lands.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry)) return [];
    if (/\.(test|itest)\.tsx?$/.test(entry)) return [];
    return [full];
  });
}

/**
 * Every JSX mount of the panel, as `{file, props}` where `props` is the raw
 * text of the element's attribute list. Deliberately textual: the question is
 * "does this call site pass the prop", which is a fact about the source.
 */
function panelMounts(): { file: string; props: string }[] {
  const found: { file: string; props: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    let from = 0;
    for (;;) {
      const at = text.indexOf('<EntityDetailPanel', from);
      if (at === -1) break;
      // To the element's own `/>` — the props are attribute text, and no
      // nested element can appear before a self-closing tag's end.
      const end = text.indexOf('/>', at);
      found.push({ file: relative(SRC, file), props: text.slice(at, end === -1 ? text.length : end) });
      from = at + 1;
    }
  }
  return found;
}

describe('panel primaries are wired at every mount site', () => {
  it('finds the mounts at all — a scan that matches nothing proves nothing', () => {
    const mounts = panelMounts();
    // Five today: WorkspaceView, EntityView ×2, ChannelView, GraphScreen. The
    // floor is what matters; a sixth screen is expected to raise it.
    expect(mounts.length).toBeGreaterThanOrEqual(5);
  });

  it('R5 #9 AT THE HOST: every mount passes onAction, so Terminate can commit', () => {
    const unwired = panelMounts()
      .filter((mount) => !/\bonAction=/.test(mount.props))
      .map((mount) => mount.file);
    expect(unwired).toEqual([]);
  });

  it('every mount passes launch sources, so Run opens its config', () => {
    const unwired = panelMounts()
      .filter((mount) => !/\blaunch=/.test(mount.props))
      .map((mount) => mount.file);
    expect(unwired).toEqual([]);
  });

  it('a host that declares wiredActions declares them beside onAction', () => {
    // Narrowing the dispatcher without naming the narrowing would silently
    // disable verbs the host CAN perform — the opposite failure, equally quiet.
    const mismatched = panelMounts()
      .filter((mount) => /\bwiredActions=/.test(mount.props) !== /\bonAction=/.test(mount.props))
      .map((mount) => mount.file);
    expect(mismatched).toEqual([]);
  });
});

describe('the dispatcher and the registry agree', () => {
  /** Every panel primary any kind declares, derived — never hand-listed. */
  const declaredPrimaries = new Set(allKinds().flatMap((config) => config.panel.primaries ?? []));

  it('every verb the dispatcher claims is actually a panel primary somewhere', () => {
    // A dispatcher entry no registry row names is dead code that reads as
    // coverage — the next person trusts the list rather than the registry.
    const dead = PANEL_PRIMARY_ACTIONS.filter((ref) => !declaredPrimaries.has(ref));
    expect(dead).toEqual([]);
  });

  it('the reported verbs are covered: Terminate dispatches, Run opens its flow', () => {
    expect(PANEL_PRIMARY_ACTIONS).toContain('terminate');
    // Run is deliberately NOT in the dispatcher — it configures before it
    // commits, so the registry's flow marker is what has to carry it.
    expect(PANEL_PRIMARY_ACTIONS).not.toContain('run');
    expect(resolveAction('run').flow).toBe('launch');
    expect(declaredPrimaries.has('run')).toBe(true);
  });

  /**
   * Driven off `allKinds()` so a kind added later is covered without anyone
   * remembering. A primary that neither dispatches nor opens a flow has no
   * executor, and is safe ONLY because `wiredActions` narrows it back to
   * disabled-with-reason. This names the ones relying on that, so the day one
   * gets an executor nobody has to rediscover the set by clicking.
   */
  it('records which primaries survive only on the wiredActions refusal', () => {
    const refusedByNarrowing = [...declaredPrimaries].filter(
      (ref) => !PANEL_PRIMARY_ACTIONS.includes(ref) && resolveAction(ref).flow !== 'launch',
    );
    // `add-child` on a doc and a channel: drawn by the registry, no executor
    // at any host. It renders disabled-with-reason, which is the honest state.
    expect(refusedByNarrowing).toEqual(['add-child']);
  });
});
