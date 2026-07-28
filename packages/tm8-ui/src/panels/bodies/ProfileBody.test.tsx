// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { allKinds } from '../../domain';
import { fixtureDetails, memberAda, teamMemberForge, teamMemberScout } from '../../fixtures';
import { PROFILE_BLOCKS, ProfileBody, type ProfileBlockRef } from './ProfileBody';

/**
 * THE PROFILE ARCHETYPE — T0-4 "All 12 kinds" frames MEMBER (oracle lines
 * 400–448) and AGENT (lines 452–496).
 *
 * WHAT THESE TESTS ARE FOR, in order of what they cost to learn:
 *
 * 1. ONE COMPONENT, TWO SCREENS. The human-member frame and the agent-teammate
 *    frame look nothing alike and are the same code path — the difference is
 *    the BLOCK LIST the registry row carries (§15.2, D30). The third test
 *    below is the one that proves it: the member's blocks rendered against the
 *    agent's detail produce the member anatomy. A `kind ===` could not do that.
 *
 * 2. THE VERDICT OUTRANKS THE RECORD (D6/D22/D27/D39, brief §2.7). The session
 *    rows are the profile's liveness surface, and the fixture is built for the
 *    exact trap: `sessionLive.state.status` says `running` forever, so a row
 *    that reads the record renders green over a dead session. The verdict
 *    arrives ONLY through `livenessOf`; with no verdict the row says
 *    `unverified`, never `running`.
 *
 * 3. HOLLOW, NEVER ZERO (D7.2). An absent stat is a dash with a reason, not a
 *    `0` that claims a measurement nobody took.
 *
 * jsdom is declared per-file (the config default is `node`), matching
 * terminal-dominant.test.tsx beside it. No localStorage is touched here, so
 * the `realSeamFlag.test.ts` stub pattern is not needed — noted rather than
 * assumed.
 */

const NOW = '2026-07-29T12:00:00.000Z';

/** The block list the `member` registry row is expected to carry (§5 handover). */
const MEMBER_BLOCKS: readonly ProfileBlockRef[] = [
  {
    block: 'identity',
    params: { provenance: 'human', tagKey: 'role', caption: 'human member', presence: true },
  },
  {
    block: 'stat-tiles',
    params: { tiles: 'taskDoneCount=tasks done,score=points,teamMembers=teammates' },
  },
  { block: 'items', label: 'TEAMMATES OWNED', params: { source: 'teamMembers' } },
  { block: 'items', label: 'CURRENT WORK', params: { source: 'work', statusKey: 'workStatus' } },
];

/** The block list the `team_member` registry row is expected to carry. */
const AGENT_BLOCKS: readonly ProfileBlockRef[] = [
  { block: 'bio', params: { source: 'identity' } },
  {
    block: 'field-grid',
    params: { fields: 'model=Model,agentTool=Tool,owner=Owner,memories=Memories' },
  },
  { block: 'live-work', params: { source: 'liveWork' } },
  { block: 'items', label: 'EQUIPPED', params: { source: 'equipped', count: true } },
  {
    block: 'session-rows',
    label: 'RECENT SESSIONS',
    params: { edgeType: 'relates_to', direction: 'incoming' },
  },
];

function detailOf(id: string) {
  const detail = fixtureDetails[id];
  if (!detail) throw new Error(`fixtures must supply a detail for ${id}`);
  return detail;
}

function renderBody(
  id: string,
  blocks: readonly ProfileBlockRef[],
  over: Partial<React.ComponentProps<typeof ProfileBody>> = {},
) {
  return render(<ProfileBody detail={detailOf(id)} blocks={blocks} now={NOW} {...over} />);
}

// ---------------------------------------------------------------------------

describe('one archetype body, two screens, chosen by registry DATA', () => {
  it('draws the human-member anatomy from the member block list', () => {
    const { getByTestId } = renderBody(memberAda.id, MEMBER_BLOCKS);

    // Identity header — T0-4 line 420-425.
    const identity = getByTestId('block-identity');
    expect(identity.textContent).toContain(detailOf(memberAda.id).title);
    expect(identity.textContent).toContain('owner'); // state.role, registry-named
    expect(identity.textContent).toContain('human member');

    // Three stat tiles — T0-4 line 427-431. Values are the fixture's REAL ones.
    const stats = getByTestId('block-stat-tiles');
    expect(stats.textContent).toContain('27'); // state.taskDoneCount
    expect(stats.textContent).toContain('340'); // state.score
    expect(stats.textContent).toContain('1'); // content.teamMembers.length
    // Lowercase in the DOM — the uppercase at line 428 is `text-transform`,
    // which is presentation and stays out of the accessible name.
    expect(stats.textContent).toContain('tasks done');

    // Chip rows — T0-4 lines 433-444.
    const chipRows = [...getByTestId('profile-body').querySelectorAll('[data-testid="block-items"]')];
    expect(chipRows).toHaveLength(2);
    expect(chipRows[0]?.textContent).toContain('TEAMMATES OWNED');
    expect(chipRows[0]?.textContent).toContain('forge');
    expect(chipRows[1]?.textContent).toContain('CURRENT WORK');
  });

  it('draws the agent-teammate anatomy from the teammate block list', () => {
    const { getByTestId } = renderBody(teamMemberForge.id, AGENT_BLOCKS);

    // Persona prose — T0-4 line 472.
    expect(getByTestId('block-bio').textContent).toContain('A0 foundation engineer');

    // Model / Tool / Owner / Memories — T0-4 lines 474-478.
    const grid = getByTestId('block-field-grid');
    expect(grid.textContent).toContain('Model');
    expect(grid.textContent).toContain('claude-fable-5');
    expect(grid.textContent).toContain('Tool');
    expect(grid.textContent).toContain('claude-code');
    expect(grid.textContent).toContain('Owner');
    expect(grid.textContent).toContain('@Ada');
    expect(grid.textContent).toContain('Memories');
    expect(grid.textContent).toContain('1'); // content.memories.length — a real count

    // Working-on row — T0-4 line 479.
    const work = getByTestId('block-live-work');
    expect(work.textContent).toContain('working on');
    expect(work.textContent).toContain('since');

    // EQUIPPED · 2 — T0-4 lines 481-485. The count rides on the eyebrow.
    const equipped = getByTestId('block-items');
    expect(equipped.textContent).toContain('EQUIPPED · 2');

    // RECENT SESSIONS — T0-4 lines 487-492.
    const sessions = getByTestId('block-session-rows');
    expect(sessions.textContent).toContain('RECENT SESSIONS');
    expect(sessions.textContent).toContain('forge');
  });

  it('renders the MEMBER anatomy against the AGENT detail when given the member blocks', () => {
    /**
     * THE NO-BRANCHING PROOF, and the reason this file exists at all. If any
     * part of this body asked what the entity IS, this render would refuse to
     * produce a member header over a teammate. It cannot ask: the anatomy is
     * the block list, and the block list is registry DATA.
     */
    const { getByTestId, queryByTestId } = renderBody(teamMemberForge.id, MEMBER_BLOCKS);
    expect(getByTestId('block-identity').textContent).toContain('human member');
    expect(queryByTestId('block-field-grid')).toBeNull();
  });

  it('renders the designed empty when the registry row declares no blocks', () => {
    const { getByTestId } = renderBody(memberAda.id, []);
    expect(getByTestId('panel-empty')).toBeTruthy();
  });
});

describe('the verdict outranks the record — the profile is a liveness consumer', () => {
  /**
   * The fixture is the trap in miniature: `sessionLive` records
   * `status: 'running'` and never changes, so any row that reads the record
   * paints a live session that may have died with the node an hour ago.
   */
  it('says what the SEAM says, not what the record says', () => {
    const { getByTestId } = renderBody(teamMemberForge.id, AGENT_BLOCKS, {
      livenessOf: () => 'stale',
    });
    const rows = getByTestId('block-session-rows').textContent ?? '';
    expect(rows).toContain('stale');
    expect(rows).not.toContain('running');
  });

  it('reads `unverified` — never `running` — when no verdict was obtained (D27)', () => {
    // livenessOf omitted entirely: nobody asked, so nothing may be claimed.
    const { getByTestId } = renderBody(teamMemberForge.id, AGENT_BLOCKS);
    const rows = getByTestId('block-session-rows').textContent ?? '';
    expect(rows).toContain('unverified');
    expect(rows).not.toContain('running');
  });

  it('paints a live verdict live', () => {
    const { getByTestId } = renderBody(teamMemberForge.id, AGENT_BLOCKS, {
      livenessOf: () => 'live',
    });
    expect(getByTestId('block-session-rows').textContent).toContain('running');
  });

  it('never claims the working-on row is live: the record carries no session to ask about', () => {
    /**
     * `LiveWork` (contract) is {actor, task, startedAt, note} — there is no
     * session reference on it, so there is no id to hand `livenessOf`. The
     * oracle's green `● live` at line 479 would therefore be a record-derived
     * liveness claim, which is the exact inference D6 forbids. It renders
     * HOLLOW instead, and the reason is reachable.
     */
    const { getByTestId } = renderBody(teamMemberForge.id, AGENT_BLOCKS, {
      livenessOf: () => 'live',
    });
    const work = getByTestId('block-live-work');
    const hollow = work.querySelector('[data-testid="hollow-inline"]');
    expect(hollow?.textContent).toContain('unverified');
    // No live-tinted verdict anywhere in the row. Asserted on the TONE rather
    // than on the substring 'live', which the hollow reason legitimately
    // contains ("A liveness verdict is never inferred…").
    expect(work.querySelector('[data-tone="run"]')).toBeNull();
  });
});

describe('honest absences', () => {
  it('renders a dash with a reason for a stat the entity does not carry — never 0', () => {
    const { getByTestId } = renderBody(teamMemberForge.id, [
      { block: 'stat-tiles', params: { tiles: 'taskDoneCount=tasks done' } },
    ]);
    const tiles = getByTestId('block-stat-tiles');
    expect(tiles.querySelector('[data-testid="hollow-stat"]')).not.toBeNull();
    expect(tiles.textContent).toContain('—');
    expect(tiles.textContent).not.toContain('0');
  });

  it('states an empty chip row as a real state, not a failed load', () => {
    const { getByTestId } = renderBody(teamMemberScout.id, [
      { block: 'items', label: 'CURRENT WORK', params: { source: 'work' } },
    ]);
    expect(getByTestId('block-items').textContent).toContain('Nothing here yet.');
  });

  it('states an absent working-on record rather than dropping the row silently', () => {
    // scout's liveWork is null — a real state the oracle never draws.
    const { getByTestId } = renderBody(teamMemberScout.id, [
      { block: 'live-work', params: { source: 'liveWork' } },
    ]);
    expect(getByTestId('block-live-work').textContent).toMatch(/nothing recorded/i);
  });

  it('states an empty session list', () => {
    const { getByTestId } = renderBody(memberAda.id, [
      { block: 'session-rows', label: 'RECENT SESSIONS', params: { edgeType: 'relates_to' } },
    ]);
    expect(getByTestId('block-session-rows').textContent).toMatch(/no sessions/i);
  });
});

describe('the registry seam — what this body can be asked to draw', () => {
  /**
   * ONE TEST IN THE GAP (brief §4.3). The registry rows are the coordinator's
   * file and their `blocks` are wired AFTER this handover; this assertion is
   * the contract between the two halves, and it is what turns a typo in a
   * block name from a silently-blank section into a red.
   *
   * MEASURED, not predicted: at the time of writing, both profile rows declare
   * NO blocks, so the subset check below passes over an empty set. It becomes
   * load-bearing the moment the rows are wired — which is the point — and the
   * count assertion beside it keeps this from silently scanning nothing.
   */
  it('every block name the profile rows declare is one this body renders', () => {
    const profileRows = allKinds().filter((row) => row.panel.archetype === 'profile');
    expect(profileRows.length).toBeGreaterThanOrEqual(2);
    for (const row of profileRows) {
      for (const block of row.panel.blocks ?? []) {
        expect(PROFILE_BLOCKS, `${row.kind} declares an unrenderable block`).toContain(block.block);
      }
    }
  });

  it("takes the registry's own `panel.blocks` array with no cast at the call site", () => {
    /**
     * THE DECLARATION→CALL LINK (D57.1). `ProfileBlockRef` widens
     * `ContentBlockRef` at `block`, and "assignable" is a claim until someone
     * writes the assignment: this line IS the wiring the coordinator will do
     * in EntityDetailPanel, compiled. If the shapes ever drift, this stops
     * compiling here rather than in their file.
     *
     * NOTE for whoever runs the checks: the package tsconfig EXCLUDES
     * `*.test.tsx`, so `bunx tsc --noEmit` does NOT see this line. It is
     * typechecked by naming the file explicitly — see the handover.
     */
    const row = allKinds().find((r) => r.panel.archetype === 'profile');
    const blocks: readonly ProfileBlockRef[] = row?.panel.blocks ?? [];
    const { getByTestId } = render(
      <ProfileBody detail={detailOf(memberAda.id)} blocks={blocks} now={NOW} />,
    );
    expect(getByTestId('profile-body')).toBeTruthy();
  });

  it('the documented block set is exactly what the two screens above use', () => {
    // Both halves: the exported list cannot quietly grow past what is drawn,
    // and the screens cannot use a name that is not in the list.
    for (const block of [...MEMBER_BLOCKS, ...AGENT_BLOCKS]) {
      expect(PROFILE_BLOCKS).toContain(block.block);
    }
  });
});
