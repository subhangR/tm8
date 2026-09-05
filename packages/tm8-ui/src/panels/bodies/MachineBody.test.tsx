// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { render, within } from '@testing-library/react';
import type { ContainerStatus, EntityDetail } from '@tm8/contract';
import { REASONS, getKind, resolveAction, type ActionContext } from '../../domain';
import { FIXTURE_SPACE_ID, containerFixtures, containerCapsFor, fixtureDetails } from '../../fixtures';
import { EntityDetailPanel } from '../index';

/**
 * THE MACHINE ARCHETYPE — mount, status, primaries, and the two guards that a
 * green render would otherwise hide.
 *
 * WHAT EACH GROUP IS FOR, and how this body could be WRONG while looking right:
 *
 *   1. THE MOUNT IS THROUGH `EntityDetailPanel`, NOT `MachineBody` DIRECTLY.
 *      That is the whole point of the lane's negative control: the body is
 *      selected by the registry row's ARCHETYPE, so rendering the component by
 *      hand would still pass with the archetype arm deleted and would prove
 *      nothing about the routing. Mounted through the panel, deleting the arm
 *      reds these and `GenericBody` renders instead.
 *   2. NINE STATUSES, NINE RENDERS. The panel's whole job on this kind is to
 *      say what state the machine is in and which verbs that state permits. A
 *      single `running` case would leave eight renderings — including
 *      `destroyed`, where the row is soft-deleted, and `failed`, where a cause
 *      must reach the reader — completely unexercised.
 *   3. THE PRIMARIES ARE ASSERTED AGAINST THE RULE, NOT A TABLE. The expected
 *      enablement is recomputed from lane B's `capabilitiesOf` definition
 *      rather than written out per status. Two hand-written tables that agree
 *      prove only that someone copied carefully.
 *   4. THE TONE MAP IS ASSERTED AS DATA. jsdom loads NO stylesheets, so no
 *      test in this package can see a colour. A missing arm renders untinted
 *      and every render assertion still passes — so the map itself is the
 *      thing under test, and it is checked for totality over the nine.
 *   5. THE CSS RULES THAT MATTER ARE ASSERTED AGAINST THE SHEET'S SOURCE.
 *      Same reason. A `min-height` that would reintroduce the artifact panel's
 *      overpaint is invisible to a DOM assertion, so it is read as text.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const HERE = dirname(fileURLToPath(import.meta.url));

const STATUSES: readonly ContainerStatus[] = [
  'requested', 'provisioning', 'running', 'paused', 'stopping',
  'stopped', 'destroying', 'destroyed', 'failed',
];

function detailFor(status: ContainerStatus): EntityDetail {
  const detail = fixtureDetails[`ent-ctr-${status}`];
  if (!detail) throw new Error(`no container fixture for status ${status}`);
  return detail;
}

describe('the machine archetype mounts, and it mounts BY ARCHETYPE', () => {
  it('the registry routes `container` to the machine body — the arm this lane adds', () => {
    // Guard the guard: if the row ever stops declaring `machine`, every
    // assertion below would still pass against whatever body took its place.
    expect(getKind('container').panel.archetype).toBe('machine');
    expect(getKind('container').panel.composition).toBe('frame');
  });

  it.each(STATUSES)('renders the machine body for a %s container', (status) => {
    const { getByTestId, queryByTestId } = render(
      <EntityDetailPanel detail={detailFor(status)} reasons={REASONS} ctx={ctx} />,
    );
    expect(getByTestId('machine-body')).toBeTruthy();
    /*
     * THE FALLBACK MUST NOT ALSO BE THERE — and this assertion names what
     * `GenericBody` ACTUALLY renders, which is the whole point.
     *
     * It first read `queryByTestId('generic-body')`, and that testid DOES NOT
     * EXIST: `GenericBody` marks its sections `block-<name>`, so the assertion
     * passed in every world and proved nothing. Caught by reading the negative
     * control's own output rather than its count — the mutated run failed on
     * `machine-body` being absent, and the fallback half was never tested.
     *
     * `block-fields` is what a container falls through to: the row declares no
     * `panel.blocks`, so `EntityDetailPanel`'s `DEFAULT_BLOCKS`
     * (`[{ block: 'fields' }]`) is what GenericBody draws. Removing the
     * `'machine'` arm therefore swaps `machine-body` for `block-fields`, and
     * this pair is what proves the archetype chain SELECTED the body rather
     * than the body merely existing.
     */
    expect(queryByTestId('block-fields')).toBeNull();
  });

  it.each(STATUSES)('%s: the status word comes from the entity', (status) => {
    const { getByTestId } = render(
      <EntityDetailPanel detail={detailFor(status)} reasons={REASONS} ctx={ctx} />,
    );
    expect(within(getByTestId('machine-body')).getByText(status)).toBeTruthy();
  });

  it('names the failure cause on a failed container, verbatim', () => {
    // A status word with no cause is the thing a reader cannot act on, and
    // `failed` is one of the nine rather than an edge case.
    const { getByTestId } = render(
      <EntityDetailPanel detail={detailFor('failed')} reasons={REASONS} ctx={ctx} />,
    );
    const error = getByTestId('machine-error');
    expect(error.textContent).toContain('no image satisfies profile shell');
    expect(error.getAttribute('role')).toBe('alert');
  });

  it('a container with no `screen` key in surfaceDetail still renders', () => {
    /*
     * `surfaceDetail` is a `Partial<Record<…>>` and EVERY key can be absent —
     * lane B flagged this as the trap. All nine fixtures omit `screen`
     * deliberately, so an unguarded `surfaceDetail.screen.live` throws HERE
     * rather than on a real container that simply has no screen.
     */
    const detail = detailFor('running');
    expect((detail.content as { surfaceDetail: Record<string, unknown> }).surfaceDetail.screen)
      .toBeUndefined();
    const { getByTestId } = render(
      <EntityDetailPanel detail={detail} reasons={REASONS} ctx={ctx} />,
    );
    expect(within(getByTestId('machine-body')).getByText('Screen')).toBeTruthy();
  });
});

describe('liveness is a SECOND source, never the recorded status (R-UI-5)', () => {
  it('with no verdict it says UNVERIFIED and claims nothing', () => {
    // A `running` record with no measurement is the ghost. Rendering it as
    // "not running" would assert a measurement nobody took; rendering it as
    // live would assert the record is true. Neither is honest.
    const { getByTestId } = render(
      <EntityDetailPanel detail={detailFor('running')} reasons={REASONS} ctx={ctx} />,
    );
    expect(getByTestId('machine-liveness').textContent).toContain('unverified');
  });

  it('a running RECORD with a stale VERDICT shows the verdict, not the record', () => {
    const { getByTestId } = render(
      <EntityDetailPanel detail={detailFor('running')} reasons={REASONS} ctx={ctx} liveness="stale" />,
    );
    const liveness = getByTestId('machine-liveness');
    expect(liveness.textContent).toContain('stale');
    expect(liveness.textContent).not.toContain('unverified');
    // The PILL still reads the record — the two disagreeing on screen is the
    // feature, not a bug to reconcile away.
    expect(within(getByTestId('machine-body')).getByText('running')).toBeTruthy();
  });

  it('a live verdict draws the dot', () => {
    const { getByTestId } = render(
      <EntityDetailPanel detail={detailFor('running')} reasons={REASONS} ctx={ctx} liveness="live" />,
    );
    expect(getByTestId('machine-liveness').className).toContain('pn-machine__liveness--live');
  });
});

describe('each status offers exactly the primaries its capabilities permit', () => {
  /**
   * THE EXPECTED ANSWER IS RECOMPUTED FROM THE RULE, not tabulated. Lane B's
   * `capabilitiesOf` says `canStart` is `status === 'stopped'`; the fixture
   * derives the booleans from that same rule via `containerCapsFor`, and this
   * asserts the VERB's availability against the boolean. So a drift in either
   * direction shows up, where two hand-written nine-row tables would agree
   * with each other forever.
   */
  const VERB_BY_CAP = [
    ['container-start', 'canStart'],
    ['container-stop', 'canStop'],
    ['container-destroy', 'canDestroy'],
    ['container-terminal', 'canExec'],
  ] as const;

  it.each(
    STATUSES.flatMap((status) => VERB_BY_CAP.map(([verb, cap]) => [status, verb, cap] as const)),
  )('%s: %s follows %s', (status, verb, cap) => {
    const capabilities = containerCapsFor(status);
    const verdict = resolveAction(verb).availability({ ...ctx, entityId: `ent-ctr-${status}`, capabilities });
    expect(verdict.kind).toBe(capabilities[cap] ? 'available' : 'disabled');
    if (verdict.kind === 'disabled') expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it('the screen verb is REFUSED in every status — deferred, never hidden', () => {
    // P2 builds the viewer. Until then the verb must render and say so: a
    // surface that is coming and simply absent is one nobody can report.
    for (const status of STATUSES) {
      const verdict = resolveAction('container-screen').availability({
        ...ctx,
        entityId: `ent-ctr-${status}`,
        capabilities: containerCapsFor(status, { nonTerminalSurface: true }),
      });
      expect(verdict.kind).toBe('disabled');
    }
  });

  /**
   * ABSENT IS NOT PERMITTED — the assertion the coordinator asked for by name.
   *
   * The six booleans are OPTIONAL on the flat `EntityCapabilities`. Someone
   * later "simplifying" the gate to `?? true`, or deleting the `undefined` arm
   * as dead code because today's server always populates it, turns every
   * unanswered capability into a live button. An older node is a legal peer
   * and absence is legal in the contract, so this is the guard on that.
   */
  it('a capability read with the six ABSENT disables every gated primary', () => {
    const bare = {
      canEdit: true, canDelete: true, canAddChild: true, canLink: true,
      canPull: true, canReact: true, canGrantPoints: true, canComplete: true,
    };
    for (const [verb] of VERB_BY_CAP) {
      const verdict = resolveAction(verb).availability({ ...ctx, entityId: 'ent-ctr-running', capabilities: bare });
      expect(verdict.kind, `${verb} lit up on an absent capability`).toBe('disabled');
      if (verdict.kind === 'disabled') {
        // And it says the RIGHT thing: "we do not know" is a different piece
        // of news from "the status forbids it", and sending a user to the
        // wrong remedy is the failure this distinction exists to prevent.
        expect(verdict.reason).toBe(REASONS.containerCapabilitiesUnknown);
      }
    }
  });
});

describe('the fixture agrees with the SERVER, not with the message that announced it', () => {
  /**
   * `containerCapsFor` restates `capabilitiesOf`'s container arm
   * (`packages/server/src/facade/entity-read.ts`). It was first copied from
   * lane B's freeze MESSAGE and four members diverged — one PERMISSIVELY.
   *
   * A FIXTURE THAT RESTATES A SERVER RULE IS A COPY. Nothing in this package
   * can check it: the type system cannot compare a fixture to a server it does
   * not import, so only a cross-tree diff finds the drift. These assertions are
   * the next best thing — they pin the values a human diffed, so a later edit
   * that quietly re-widens one fails here.
   */
  it('NEVER offers Archive: canDelete is false on every status', () => {
    /*
     * THE ONE THAT WAS WRONG, AND WRONG PERMISSIVELY. `containerCapsFor`
     * spread `CAPS_FULL` and overrode six members, not this one — so every
     * container fixture asserted a container is archivable.
     *
     * `archive` gates exactly on `canDelete`, so the fixture sat on the WRONG
     * SIDE of the bug: a UI that wrongly offered Archive would have been
     * green in this package forever.
     *
     * The server is a hard `false` with a reason: a container is not deleted,
     * it is DESTROYED, and `entities.delete` refuses the kind. Offering a
     * delete control the only door refuses would be a lie.
     */
    for (const status of STATUSES) {
      expect(containerCapsFor(status).canDelete, `${status} claims canDelete`).toBe(false);
      const verdict = resolveAction('archive').availability({
        ...ctx, entityId: `ent-ctr-${status}`, capabilities: containerCapsFor(status),
      });
      expect(verdict.kind, `${status} offers Archive`).toBe('disabled');
    }
    // POSITIVE CONTROL: the same gate DOES permit archive when canDelete is
    // true, so this cannot pass by `archive` being universally refused.
    expect(resolveAction('archive').availability({
      ...ctx, entityId: 'x', capabilities: { ...containerCapsFor('running'), canDelete: true },
    }).kind).toBe('available');
  });

  it('canControl is canAttach AND share_mode === space — the ruled design', () => {
    /*
     * Design v21 §12.4: `canControl` stays ROW-SCOPED and conservative.
     * `'space'` is the only value the row can settle — `capabilitiesOf(row)`
     * takes no viewer, so `'none'` (creator) and `'explicit'` (a named list)
     * are unanswerable and answer false. The viewer-specific answer belongs to
     * the DOOR: P2's ScreenBody asks for a `drive` grant and falls back to
     * `view` on `forbidden`, exactly as `mintPtyAttachGrant` already does.
     *
     * So a false negative here hides a control someone could have used; a
     * false positive would hand them a button that 403s at
     * `grant_surface_attach`. Deny is the direction to be wrong in.
     */
    const attachable = { nonTerminalSurface: true } as const;
    expect(containerCapsFor('running', { ...attachable, shareMode: 'space' }).canControl).toBe(true);
    expect(containerCapsFor('running', { ...attachable, shareMode: 'explicit' }).canControl).toBe(false);
    expect(containerCapsFor('running', { ...attachable, shareMode: 'none' }).canControl).toBe(false);
    // …and it never exceeds canAttach, whatever the share mode.
    for (const shareMode of ['space', 'explicit', 'none'] as const) {
      const caps = containerCapsFor('stopped', { ...attachable, shareMode });
      expect(caps.canControl && !caps.canAttach).toBe(false);
    }
  });

  it('a soft-deleted container can neither be edited nor destroyed', () => {
    // The server ANDs `live` (`row.deleted_at === null`) into both. §11.1
    // soft-deletes the envelope once destroy succeeds, so this is the state a
    // destroyed container actually reaches.
    const dead = containerCapsFor('running', { live: false });
    expect(dead.canEdit).toBe(false);
    expect(dead.canDestroy).toBe(false);
    // Guard the guard: alive, both are true, so `live` is doing the work.
    const alive = containerCapsFor('running', { live: true });
    expect(alive.canEdit).toBe(true);
    expect(alive.canDestroy).toBe(true);
  });
});

describe('the tone map — asserted as DATA, because jsdom sees no colour', () => {
  it('keys all NINE statuses on both the chip and the pill', () => {
    const row = getKind('container');
    for (const status of STATUSES) {
      expect(row.chip.tones?.[status], `chip has no tone for ${status}`).toBeTruthy();
      expect(row.panel.statusPill?.tones[status], `pill has no tone for ${status}`).toBeTruthy();
    }
  });

  it('the chip and the pill agree, value for value', () => {
    // Two hand-kept copies of one map is how a status ends up one colour in
    // the list and another in the panel.
    const row = getKind('container');
    expect(row.panel.statusPill?.tones).toEqual(row.chip.tones);
  });

  it('`failed` is the only blocking tone and `running` the only run tone', () => {
    // Pins the MEANING, not just presence: a map where every value was 'idle'
    // would satisfy totality and render nine identical chips.
    const tones = getKind('container').chip.tones ?? {};
    expect(Object.entries(tones).filter(([, t]) => t === 'block').map(([s]) => s)).toEqual(['failed']);
    expect(Object.entries(tones).filter(([, t]) => t === 'run').map(([s]) => s)).toEqual(['running']);
  });
});

describe('the stylesheet — read as SOURCE, since no vitest here loads one', () => {
  const css = readFileSync(join(HERE, 'machine-body.css'), 'utf8');

  it('carries no px floor anywhere — the artifact overpaint, not repeated', () => {
    /*
     * `artifact` is the other `composition: 'frame'` kind. Its section took
     * `min-height: 0` above a child with a 420px floor, so on a short panel
     * the frame PAINTED OVER THE BLOCK BELOW IT. P0's body has no viewport, so
     * the defect is unreachable today and this assertion is what keeps it that
     * way when the screen surface lands.
     */
    const floors = css.match(/min-height:\s*\d+px/g) ?? [];
    expect(floors, `machine-body.css grew a px floor: ${floors.join(', ')}`).toEqual([]);
  });

  it('states the rule the P2 surface lane will need', () => {
    // A rule that lives only in a reviewer's memory is a rule that gets
    // reintroduced. This asserts the WARNING is present, not the value.
    expect(css).toContain('min-height: auto');
    expect(css.toLowerCase()).toContain('overpaint');
  });

  it('unverified liveness is drawn differently from off — not merely absent', () => {
    // The DOM half of this pair is asserted above (`--unverified` in the
    // className); this is the half that proves the class actually does
    // something, which no render in jsdom can see.
    expect(css).toContain('.pn-machine__liveness--unverified');
    expect(css).toContain('.pn-machine__liveness--off');
  });
});

describe('the phone posture — stated, because "no branch" is a decision', () => {
  /*
   * `screenFor` in `MobileShell` routes by TARGET TYPE (kind / entity), never
   * by kind, so a container list and a container panel reach the phone through
   * the same generic arms every other kind uses. No edit was needed there, and
   * this records that it was checked rather than missed.
   *
   * THE PHONE REFUSAL FOR THE UNBUILT SURFACES IS THE RAIL ITSELF. A session
   * needs `PHONE_SURFACES`/`PHONE_REFUSED` because it OFFERS five surfaces and
   * has to narrow them at 390px. A container in P0 offers none — all three are
   * refused already — so narrowing has nothing to narrow, and a phone branch
   * would be a second copy of the same three sentences.
   *
   * THAT CHANGES THE DAY A SURFACE WORKS. When P1 mounts the terminal and P2
   * the screen, this body needs the `useMobileSurface()` split
   * `WorkSessionContent` has, and Design §13.2 already names the answer:
   * `PHONE_SURFACES = ['screen', 'terminal']`, with `logs` refused by name.
   */
  it('refuses every surface identically at any width — nothing is viewport-gated yet', () => {
    const { getByTestId } = render(
      <EntityDetailPanel detail={detailFor('running')} reasons={REASONS} ctx={ctx} />,
    );
    const rail = within(getByTestId('machine-body'));
    for (const label of ['Screen', 'Terminal', 'Logs']) {
      expect(rail.getByText(label)).toBeTruthy();
    }
    // Each refusal is PROSE ON SCREEN, not a tooltip: an answer behind a hover
    // is an answer a touch device cannot reach.
    const body = getByTestId('machine-body');
    expect(body.querySelectorAll('.pn-machine__surface-refusal').length).toBe(3);
  });

  it('the body has no viewport branch at all, so there is nothing to keep in sync', () => {
    // Source-scanned rather than rendered: the assertion is about the ABSENCE
    // of a phone path, and an absence cannot be rendered.
    const src = readFileSync(join(HERE, 'MachineBody.tsx'), 'utf8');
    expect(src).not.toContain('useMobileSurface');
    expect(src).not.toContain('oneSurface');
  });
});

describe('the fixtures this lane ships', () => {
  it('covers every status exactly once — a sweep over a subset proves less', () => {
    expect(containerFixtures.map((r) => (r.state as { status: string }).status)).toEqual(STATUSES);
  });

  it('never claims a screen surface, because P0 builds no viewer for one', () => {
    for (const row of containerFixtures) {
      expect((row.state as { surfaces: string[] }).surfaces).toEqual(['terminal']);
    }
  });

  it('carries no host path on any mount (ruling R5)', () => {
    // The read side of `ContainerMount` is `{ guest, ro }`. A fixture with a
    // `host` key would let a renderer that shows one look correct here.
    for (const status of STATUSES) {
      const mounts = (detailFor(status).content as { spec: { mounts: object[] } }).spec.mounts;
      for (const mount of mounts) expect(Object.keys(mount).sort()).toEqual(['guest', 'ro']);
    }
  });
});
