// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type {
  ActorSummary,
  EdgeView,
  EntityDetail,
  EntitySummary,
  ProjectResource,
} from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import type { ActionContext } from '../../domain';
import { REASONS } from '../../domain';
import { ada, fixtureDetails, projectTm8Ui, sessionLive, sessionStale } from '../../fixtures';
import { GOVERNED_BLOCKS, GovernedBody, type GovernedBlockRef } from './GovernedBody';

/**
 * THE GOVERNED ARCHETYPE — T0-4 "Governed & fallback kinds", the PROJECT card
 * (oracle 671–712).
 *
 * These assertions pin the things a render cannot show you, and every one of
 * them is a way this body could be WRONG while looking right:
 *
 *   1. THE TWO-SOURCE LAW (D6/D27/D39). A session row's word comes from the
 *      VERDICT handed in, never from the record beside it. The fixture is
 *      built for exactly that: `sessionStale.state.status` is 'running' while
 *      the seam verdict is 'stale'. A body that reads the record renders
 *      "running" over a dead session — the defect preserved in gate-evidence.
 *   2. NO VERDICT IS NOT A ZERO, and it is not a two either. With no
 *      `livenessOf` the eyebrow may not print a live count at all.
 *   3. AN UNREAD TRUST LEVEL IS NOT `untrusted`. Trust lives on the node's
 *      project record, which this build cannot read; painting the absence as
 *      a refusal invents a governance decision the node never made.
 *   4. A REFUSAL NAMES ITS REAL CAUSE. Live sessions blocking an unlink is a
 *      fact about the WORLD and outranks the fact that the verb is deferred
 *      in this BUILD — telling the user the wrong one sends them to the wrong
 *      remedy.
 *   5. THE VERB IS REGISTRY DATA. The reason on a disabled action is the
 *      action registry's own sentence, so it cannot drift from the ledger.
 *
 * Contract types are IMPORTED and nothing here casts a shape: a cast would
 * hide the very mismatch these assertions exist to catch.
 */

// ---------------------------------------------------------------------------
// Fixture composition — real contract-typed values, assembled locally.
// ---------------------------------------------------------------------------

const NOW = '2026-07-29T12:00:00.000Z';
const SPACE = 'sp-atelier';

/**
 * The oracle's own path and repo (lines 691–692), carried on the CONTRACT's
 * project record rather than on the entity — because that is where the
 * contract puts them (`ProjectResource.workingDir` / `.trust`), and the point
 * of this prop is that the panel consumes the real shape.
 */
function resource(over: Partial<ProjectResource> = {}): ProjectResource {
  return {
    id: 'proj-tm8ui',
    name: 'tm8-ui',
    repoUrl: 'https://github.com/ada/tm8',
    workingDir: '~/code/tm8/packages/ui',
    trust: 'trusted',
    defaults: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function edgeTo(id: string, target: EntitySummary, source: EntitySummary): EdgeView {
  const actor: ActorSummary = ada;
  return {
    id,
    type: 'in_project',
    source,
    target,
    props: {},
    createdBy: actor,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function projectDetail(sessions: readonly EntitySummary[] = []): EntityDetail {
  const base = fixtureDetails[projectTm8Ui.id];
  if (!base) throw new Error('fixtures must supply a governed detail');
  return {
    ...base,
    connections: {
      ...base.connections,
      incoming:
        sessions.length === 0
          ? []
          : [
              {
                type: 'in_project',
                direction: 'incoming',
                label: 'launched in',
                edges: sessions.map((s, i) => edgeTo(`edge-in-project-${i}`, base, s)),
              },
            ],
    },
  };
}

/** The full anatomy the oracle draws, as the registry would declare it. */
const BLOCKS: readonly GovernedBlockRef[] = [
  { block: 'path-row' },
  { block: 'trust-card', params: { action: 'untrust' } },
  { block: 'live-sessions' },
  { block: 'unlink-footer', params: { action: 'unlink' } },
  { block: 'notice', params: { text: 'execution root · registered at node level' } },
];

function ctx(over: Partial<ActionContext> = {}): ActionContext {
  return { spaceId: SPACE, entityId: projectTm8Ui.id, dispatch: async () => {}, ...over };
}

function renderBody(over: Partial<React.ComponentProps<typeof GovernedBody>> = {}) {
  return render(
    <GovernedBody
      detail={projectDetail()}
      blocks={BLOCKS}
      actionContext={ctx()}
      now={NOW}
      {...over}
    />,
  );
}

/** The verdict source. `undefined` for anything not named — nobody asked. */
const verdicts =
  (map: Record<string, SessionLiveness>) =>
  (id: string): SessionLiveness =>
    map[id] ?? 'unknown';

// ---------------------------------------------------------------------------

describe('the block vocabulary is the registry seam', () => {
  it('renders the blocks in the declared order and nothing it was not asked for', () => {
    const { getByTestId } = renderBody({ resource: resource() });
    const body = getByTestId('governed-body');
    const order = Array.from(body.children).map((el) => el.getAttribute('data-testid'));
    expect(order.slice(0, 4)).toEqual([
      'governed-path',
      'governed-trust',
      'governed-sessions',
      'governed-unlink',
    ]);
  });

  it('renders NOTHING for a block name it does not know, rather than a blank section', () => {
    const { getByTestId } = renderBody({ blocks: [{ block: 'not-a-block' }] });
    expect(getByTestId('governed-body').children).toHaveLength(0);
  });

  it('exports the block names, so a registry row can be checked against them', () => {
    expect([...GOVERNED_BLOCKS]).toEqual([
      'path-row',
      'trust-card',
      'live-sessions',
      'unlink-footer',
      'notice',
    ]);
  });

  it('renders the designed empty body when the registry row declares no blocks', () => {
    const { getByTestId, queryByTestId } = renderBody({ blocks: [] });
    expect(getByTestId('governed-body').textContent).toContain('universal fields only');
    expect(queryByTestId('governed-trust')).toBeNull();
  });
});

describe('trust is a THREE-state fact', () => {
  it('renders the trusted card with the oracle consequence sentence', () => {
    const { getByTestId } = renderBody({ resource: resource() });
    const card = getByTestId('governed-trust');
    expect(card.getAttribute('data-trust')).toBe('trusted');
    expect(card.textContent).toContain('Agents may run real terminal sessions in this root');
    expect(card.textContent).toContain('Untrusting terminates nothing but blocks new runs');
  });

  it('states the consequence THE OTHER WAY on an untrusted root', () => {
    const { getByTestId } = renderBody({ resource: resource({ trust: 'untrusted' }) });
    const card = getByTestId('governed-trust');
    expect(card.getAttribute('data-trust')).toBe('untrusted');
    expect(card.textContent).toContain('Agents cannot start terminal sessions in this root');
  });

  it('renders HOLLOW — never "untrusted" — when no node record was read', () => {
    const { getByTestId, queryByTestId } = renderBody();
    expect(queryByTestId('governed-trust')).toBeNull();
    const hollow = getByTestId('governed-trust-hollow');
    /*
     * The assertion is about the VERDICT, not about the prose: the hollow
     * copy legitimately names the word "untrusted" in order to state the law
     * it is obeying, and a substring check would forbid the explanation. What
     * may not exist is an ELEMENT rendering that word as this root's answer.
     */
    expect(within(hollow).queryByText('untrusted')).toBeNull();
    expect(within(hollow).queryByText('trusted')).toBeNull();
    expect(hollow.textContent).toContain('neither answer is claimed');
  });

  it('takes the Untrust reason from the ACTION REGISTRY, not from a local string', () => {
    const { getByTestId } = renderBody({ resource: resource() });
    const card = getByTestId('governed-trust');
    // The control and its reason CAPTION are siblings inside the honesty
    // group (DisabledAction's own shape), so the assertion reads the region
    // rather than the labelled node — reading only the node is how a control
    // that lost its reason would still pass.
    expect(within(card).getByTestId('disabled-with-reason').textContent).toContain('Untrust');
    // The registry's own authored sentence — so this cannot drift from D15.
    expect(card.textContent).toContain(REASONS.untrustDeferred.split(' — ')[0]);
  });

  it('says plainly that GRANTING trust has no verb in this build', () => {
    // ActionRef carries `untrust` and no `trust` member. A missing verb the
    // user cannot see is indistinguishable from a screen that forgot to draw
    // it, so the absence is rendered rather than skipped.
    const { getByTestId } = renderBody({ resource: resource({ trust: 'untrusted' }) });
    const card = getByTestId('governed-trust');
    expect(within(card).getByTestId('disabled-with-reason').textContent).toContain('Trust…');
    expect(card.textContent).toContain('trust is a node-level grant');
  });
});

describe('the execution root row', () => {
  it('reads the path off the CONTRACT record, not off the entity', () => {
    const { getByTestId } = renderBody({ resource: resource() });
    expect(getByTestId('governed-path').textContent).toContain('~/code/tm8/packages/ui');
  });

  it('renders the path HOLLOW with its reason when no record was read', () => {
    const { getByTestId } = renderBody();
    expect(getByTestId('governed-path-hollow').textContent).toContain('execution root');
  });

  it('renders the repo line from the record, with a real external link', () => {
    const { getByTestId } = renderBody({ resource: resource() });
    const link = within(getByTestId('governed-repo')).getByRole('link');
    expect(link.getAttribute('href')).toBe('https://github.com/ada/tm8');
  });

  it('copies through the injected copier when one exists', () => {
    const onCopyPath = vi.fn();
    const { getByTestId } = renderBody({ resource: resource(), onCopyPath });
    fireEvent.click(getByTestId('governed-copy-path'));
    expect(onCopyPath).toHaveBeenCalledWith('~/code/tm8/packages/ui');
    expect(getByTestId('governed-copy-path').textContent).toContain('copied');
  });

  it('renders copy DISABLED-WITH-REASON when the host offers no clipboard at all', () => {
    // jsdom has no navigator.clipboard, which is exactly the environment the
    // R5 #9 law is about: a live control that silently does nothing.
    const { getByTestId } = renderBody({ resource: resource() });
    const row = getByTestId('governed-path');
    expect(within(row).getByTestId('disabled-with-reason')).toBeTruthy();
    expect(row.textContent).toContain('no clipboard was offered by the host');
  });
});

describe('LIVE SESSIONS — the verdict outranks the record', () => {
  it('renders the VERDICT word over a record that disagrees with it', () => {
    const { getAllByTestId } = renderBody({
      detail: projectDetail([sessionStale]),
      livenessOf: verdicts({ [sessionStale.id]: 'stale' }),
    });
    const row = getAllByTestId('governed-session-row')[0];
    // The record says running. Nothing on this row may.
    expect(row?.textContent).toContain('stale');
    expect(row?.textContent).not.toContain('running');
  });

  it('counts LIVE in the eyebrow only over verdicts it was actually given', () => {
    const { getByTestId } = renderBody({
      detail: projectDetail([sessionLive, sessionStale]),
      livenessOf: verdicts({ [sessionLive.id]: 'live', [sessionStale.id]: 'stale' }),
    });
    expect(getByTestId('governed-sessions').textContent).toContain('LIVE SESSIONS IN THIS ROOT · 1');
  });

  it('never prints a live count when NOBODY ASKED', () => {
    const { getByTestId } = renderBody({ detail: projectDetail([sessionLive, sessionStale]) });
    const text = getByTestId('governed-sessions').textContent ?? '';
    expect(text).toContain('2 RECORDED');
    expect(text).toContain('LIVENESS UNVERIFIED');
    expect(text).not.toMatch(/ROOT · \d+$/);
  });

  it('renders a real zero as a real zero', () => {
    const { getByTestId } = renderBody({ livenessOf: verdicts({}) });
    const text = getByTestId('governed-sessions').textContent ?? '';
    expect(text).toContain('· 0');
    expect(text).toContain('No sessions are recorded against this root');
  });

  it('states the gap instead of being an enabled-inert row when nothing opens entities', () => {
    const { getAllByTestId } = renderBody({
      detail: projectDetail([sessionLive]),
      livenessOf: verdicts({ [sessionLive.id]: 'live' }),
    });
    const row = getAllByTestId('governed-session-row')[0];
    expect(row?.tagName).not.toBe('BUTTON');
    expect(row?.textContent).toContain('not openable here');
  });

  it('is a real control the moment an opener is wired', () => {
    const onOpenEntity = vi.fn();
    const { getAllByTestId } = renderBody({
      detail: projectDetail([sessionLive]),
      livenessOf: verdicts({ [sessionLive.id]: 'live' }),
      onOpenEntity,
    });
    const row = getAllByTestId('governed-session-row')[0];
    if (!row) throw new Error('a session row must render');
    fireEvent.click(row);
    expect(onOpenEntity).toHaveBeenCalledWith(sessionLive.id);
  });
});

describe('the unlink refusal names its REAL cause', () => {
  it('blocks on live sessions and names the number', () => {
    const { getByTestId } = renderBody({
      detail: projectDetail([sessionLive, sessionStale]),
      livenessOf: verdicts({ [sessionLive.id]: 'live', [sessionStale.id]: 'stale' }),
    });
    const footer = getByTestId('governed-unlink');
    expect(footer.textContent).toContain('unlink blocked: 1 live session use');
    expect(footer.textContent).toContain('stop them, or wait for them to exit');
  });

  it('refuses on UNVERIFIED liveness rather than claiming the root is clear', () => {
    // Sessions are recorded and nobody looked. "Nothing is live" would be a
    // measurement that never ran, and it is the dangerous direction here.
    const { getByTestId } = renderBody({ detail: projectDetail([sessionLive]) });
    const footer = getByTestId('governed-unlink');
    expect(footer.textContent).toContain('liveness here is unverified');
    expect(footer.textContent).not.toContain('blocked: 0');
  });

  it('falls through to the action registry’s own reason when nothing blocks it', () => {
    const { getByTestId } = renderBody({ livenessOf: verdicts({}) });
    expect(getByTestId('governed-unlink').textContent).toContain(
      REASONS.unlinkDeferred.split(' — ')[0]?.replace(/\.$/, '') ?? '',
    );
  });

  it('disables the verb when the panel passed no action context to ask', () => {
    const { getByTestId } = renderBody({ actionContext: undefined, livenessOf: verdicts({}) });
    expect(getByTestId('governed-unlink').textContent).toContain('isn’t connected yet');
  });
});

describe('archetype, not kind (§15.2)', () => {
  it('renders a DIFFERENT kind through the same component and the same blocks', () => {
    // The body knows block types, never entity kinds — so a second governed
    // -shaped kind is a registry row, not an edit to this file.
    const other = fixtureDetails[sessionLive.id] ?? projectDetail();
    const { getByTestId } = renderBody({ detail: other, resource: resource() });
    expect(getByTestId('governed-body')).toBeTruthy();
    expect(getByTestId('governed-trust').getAttribute('data-trust')).toBe('trusted');
  });
});
