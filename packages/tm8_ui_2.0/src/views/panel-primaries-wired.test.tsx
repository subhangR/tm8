import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REASONS, allKinds, deferredActions, processControlFor, resolveAction } from '../domain';
import { PANEL_PRIMARY_ACTIONS } from './usePanelPrimaries';
import { ENTITY_VERB_ACTIONS } from './useEntityVerbs';

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
/**
 * The end of the element's OWN opening tag — the first `/>` or `>` that is not
 * nested inside a prop expression or a string.
 *
 * REVIEW F4, and the finding was BIGGER than reported. The first version cut
 * at `text.indexOf('/>')`, which the review flagged as fragile for "a future
 * mount with children". It was already wrong TODAY: `EntityView` passes
 * `conversationSurface={<LazySessionChatSurface … />}`, so the slice ended at that
 * nested element's `/>` and silently dropped every prop after it. The wiring
 * assertions passed only because `onAction` and `launch` happen to be written
 * above `conversationSurface` — luck, not coverage. A guard that fails OPEN is worse
 * than no guard, because it is believed.
 */
function openingTagOf(text: string, at: number): { props: string; closed: boolean } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = at + 1; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') { depth -= 1; continue; }
    if (depth > 0) continue;
    if (ch === '/' && text[i + 1] === '>') return { props: text.slice(at, i), closed: true };
    // A bare `>` at depth 0 ends a CHILDREN-form tag; the props are still
    // everything before it, so the wiring checks stay correct either way.
    if (ch === '>') return { props: text.slice(at, i), closed: true };
  }
  return { props: text.slice(at), closed: false };
}

/**
 * Comments out, before any quote tracking runs.
 *
 * These files comment densely and in prose, so a prop list contains
 * `tombstone's way back` and `` `restore` `` — an apostrophe and a backtick
 * that are not string delimiters at all. Tracking quotes across them opened a
 * string that never closed and the scan ran to EOF. Same strip the sibling
 * §15.2 guards use, for the same reason.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function panelMounts(): { file: string; props: string; closed: boolean }[] {
  const found: { file: string; props: string; closed: boolean }[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = stripComments(readFileSync(file, 'utf8'));
    let from = 0;
    for (;;) {
      const at = text.indexOf('<EntityDetailPanel', from);
      if (at === -1) break;
      found.push({ file: relative(SRC, file), ...openingTagOf(text, at) });
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

  it('REVIEW F4: the prop scan terminates on every mount, and reads the WHOLE list', () => {
    const mounts = panelMounts();
    // An unterminated tag means the parser ran to EOF and the assertions below
    // would be reading half a file.
    expect(mounts.filter((m) => !m.closed).map((m) => m.file)).toEqual([]);

    // The regression that motivated the rewrite: EntityView passes a nested
    // element inside `conversationSurface`, and the old scan stopped there. Its props
    // must reach the ones written AFTER it, or this guard proves nothing about
    // the tail of any mount.
    const nested = mounts.filter((m) => m.props.includes('conversationSurface='));
    expect(nested.length).toBeGreaterThan(0);
    for (const mount of nested) {
      expect(mount.props).toContain('onOpenEntity=');
    }
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

  /**
   * B10, and the SECOND verb to need this guard. `merge-pr` stopped being a
   * deferral when `tracking.pr.merge` shipped, so its availability no longer
   * refuses on its own — a host that forgets the executor now draws a live
   * `Merge…` whose confirm cannot commit. That is precisely the enabled-inert
   * shape this file was written about, one verb later.
   */
  it('every mount passes merge sources, so Merge… can commit its confirm', () => {
    const unwired = panelMounts()
      .filter((mount) => !/\bmergePr=/.test(mount.props))
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

  /**
   * Every primary the bar can DRAW, which since the process control is not the
   * same set as the one the registry declares: `ActionBar` resolves a declared
   * slot through `processControlFor`, so a finished session's bar shows
   * `resume` where the registry says `terminate`. Derived by running the
   * resolver over the declared set rather than by adding `resume` to a literal
   * — the swap has one definition and this guard consults it.
   */
  const ENDED = { category: 'done', liveness: 'not-running' } as const;
  const drawablePrimaries = new Set(
    [...declaredPrimaries].flatMap((ref) => [ref, processControlFor(ref, ENDED)]),
  );

  it('the process control swap is what puts resume in reach, not a hand-added entry', () => {
    // Guard the guard: if the swap ever stops producing `resume`, the widened
    // set below silently collapses back to the declared one and the dead-code
    // check starts passing for the wrong reason.
    expect(declaredPrimaries.has('resume')).toBe(false);
    expect(drawablePrimaries.has('resume')).toBe(true);
    expect(processControlFor('terminate', { category: 'in_progress', liveness: 'live' })).toBe('terminate');
  });

  it('every verb the dispatcher claims is actually a panel primary somewhere', () => {
    // A dispatcher entry no registry row names — and that no swap can put in
    // that slot — is dead code that reads as coverage: the next person trusts
    // the list rather than the registry.
    const dead = PANEL_PRIMARY_ACTIONS.filter((ref) => !drawablePrimaries.has(ref));
    expect(dead).toEqual([]);
  });

  it('REVIEW: every launch verb commits its OWN mode — Coordinate is not Run', () => {
    /*
     * One config serves all of them, and it seeded `worker` unconditionally.
     * Making Coordinate live in the panel therefore gave a team_member a
     * button labelled Coordinate that spawned a WORKER — the button naming
     * one act and performing another, which is the same honesty failure as an
     * enabled-inert control, only louder because it succeeds.
     *
     * Asserted as DATA off the registry rather than by rendering: the mapping
     * is what has to be right, and a surface asking `ref === 'coordinate'`
     * would be the action-id literal §15.2 keeps out of components.
     */
    const launchVerbs = [...declaredPrimaries].filter((ref) => resolveAction(ref).flow === 'launch');
    expect(launchVerbs.length).toBeGreaterThan(0);

    // Run is the default (`worker`) and says so by omission.
    expect(resolveAction('run').launchMode).toBeUndefined();
    // Coordinate is the whole reason the field exists.
    expect(resolveAction('coordinate').launchMode).toBe('coordinator');
    // No two launch verbs may be indistinguishable at commit time.
    const modes = launchVerbs.map((ref) => resolveAction(ref).launchMode ?? 'worker');
    expect(new Set(modes).size).toBe(modes.length);
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
  /**
   * B10 — THE INVERSION, kept rather than deleted because the deletion would
   * lose the record of what changed.
   *
   * `merge-pr` used to be the example this file named: a DEFERRED primary
   * whose own `availability()` refused in every context, carrying authored
   * copy that said this node only had the read-only tracker. `tracking.pr.merge`
   * made that precondition false, so the deferral was retired and the reason
   * string deleted. Asserting the ABSENCE is the point — a reason that outlives
   * the gap it described is this package asserting a limitation the seam has
   * since filled, and nothing else in the build would notice.
   */
  it('B10: Merge… is live and its deferral reason is gone', () => {
    const merge = resolveAction('merge-pr');
    // Live on a real entity: the only gate left is op availability, which an
    // empty context does not refuse.
    expect(merge.availability({ spaceId: 'probe', entityId: 'probe-entity' }).kind).toBe('available');
    // It opens a confirm rather than dispatching — the ellipsis is a promise.
    expect(merge.flow).toBe('merge-pr');
    expect(merge.label.endsWith('…')).toBe(true);
    // The retired copy, gone from the reason table entirely.
    expect(Object.keys(REASONS)).not.toContain('mergePrDeferred');
    // `.id`, not `.ref`: `ActionDef` has no `ref`, so the original spelling
    // mapped every entry to `undefined` and this line could never have
    // failed — a retirement guard that was itself retired by a typo.
    expect(deferredActions().map((def) => def.id)).not.toContain('merge-pr');
  });

  it('records which primaries survive only on the wiredActions refusal', () => {
    // A DEFERRED primary is not relying on the narrowing: its own
    // availability() refuses with a named reason in every context, which is
    // the §10.7 disabled-with-reason home — probed here the same way
    // deferredActions() probes it.
    const alwaysRefused = (ref: (typeof PANEL_PRIMARY_ACTIONS)[number]) =>
      resolveAction(ref).availability({ spaceId: 'probe' }).kind === 'disabled'
      && resolveAction(ref).availability({
        spaceId: 'probe',
        entityId: 'probe-entity',
        liveness: 'live',
        capabilities: {
          canEdit: true, canDelete: true, canAddChild: true, canLink: true,
          canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
        },
      }).kind === 'disabled';
    const refusedByNarrowing = [...declaredPrimaries].filter(
      (ref) =>
        !PANEL_PRIMARY_ACTIONS.includes(ref)
        && !ENTITY_VERB_ACTIONS.includes(ref)
        // ANY flow verb has an executor — its surface. Written as `!== 'launch'`
        // until B10 added a second flow, at which point the equality was itself
        // the action-id literal §15.2 keeps out, and `merge-pr` would have been
        // reported as unwired while being wired through its confirm.
        && resolveAction(ref).flow == null
        && !alwaysRefused(ref),
    );
    // EMPTY TODAY, and it took two dispatchers to get here: `terminate` from
    // `usePanelPrimaries`, `edit` and `add-child` from `useEntityVerbs`, the
    // launch verbs from their own flow. `add-child` was the last one relying on
    // the refusal — it is a subchannel now. A primary added without an executor
    // reappears here, which is the whole point of recording the set.
    expect(refusedByNarrowing).toEqual([]);
  });
});
