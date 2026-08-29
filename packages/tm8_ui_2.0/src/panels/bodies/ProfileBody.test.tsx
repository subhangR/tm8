// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { allKinds, getKind } from '../../domain';
import {
  fixtureDetails,
  memberAda,
  memoryDisputed,
  memorySuperseded,
  memoryTokens,
  teamMemberForge,
  teamMemberScout,
} from '../../fixtures';
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
  /* `tagKey: 'role'` was DROPPED (wave 3, deliberate): the member panel's
     header status pill already states the role as color+word, so the identity
     tag was a second copy of the same fact two rows apart. The kind-true
     `empty` params below replaced the generic 'Nothing here yet.' fallback on
     both chip rows — supported ItemsBlock data that had been left unset. */
  {
    block: 'identity',
    params: { provenance: 'human', caption: 'human member', presence: true },
  },
  {
    block: 'stat-tiles',
    params: { tiles: 'taskDoneCount=tasks done,score=points,teamMembers=teammates' },
  },
  {
    block: 'items',
    label: 'TEAMMATES OWNED',
    params: { source: 'teamMembers', empty: 'Owns no teammates.' },
  },
  {
    block: 'items',
    label: 'CURRENT WORK',
    params: { source: 'work', statusKey: 'status', empty: 'No current work recorded.' },
  },
];

/** The block list the `team_member` registry row is expected to carry. */
const AGENT_BLOCKS: readonly ProfileBlockRef[] = [
  { block: 'bio', params: { source: 'identity' } },
  /*
   * `memories=Memories` was REMOVED from this grid, and the old expectation
   * asserting it is gone with it rather than relaxed.
   *
   * It was the tested-shut case: `FieldValue` prints an array as its length,
   * the array was `team_members.memories`, and migration 084 emptied that
   * column after moving every entry into the graph as `memory` entities. The
   * cell could only ever print `0` from then on, and this suite would have
   * stayed green while it did — the assertion below used to read
   * `toContain('1')` against fixture jsonb no production row still carries.
   * The working set is now the `memory-set` block, read from `remembers`.
   */
  {
    block: 'field-grid',
    params: { fields: 'model=Model,agentTool=Tool,owner=Owner' },
  },
  { block: 'live-work', params: { source: 'liveWork' } },
  /* `empty` (wave 3): the loadout section's kind-true absence, replacing the
     generic ItemsBlock fallback — registry data the param always supported. */
  {
    block: 'items',
    label: 'EQUIPPED',
    params: {
      source: 'equipped',
      count: true,
      empty: 'Nothing equipped — this teammate launches with no spells or skills.',
    },
  },
  {
    block: 'memory-set',
    label: 'MEMORIES',
    params: { edgeType: 'remembers', direction: 'outgoing', dstKind: 'memory', count: true },
  },
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
    /* PIN MOVED (wave 3, deliberate): the role word is NOT in the identity
       block any more — the panel's header status pill owns the role statement
       (color+word), and the `tagKey: 'role'` tag was a second copy of the
       same fact two rows below it. Asserting the absence is what stops the
       duplicate being re-added as a "missing field". */
    expect(identity.textContent).not.toContain('owner');
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

    // Model / Tool / Owner — T0-4 lines 474-478.
    const grid = getByTestId('block-field-grid');
    expect(grid.textContent).toContain('Model');
    expect(grid.textContent).toContain('claude-fable-5');
    expect(grid.textContent).toContain('Tool');
    expect(grid.textContent).toContain('claude-code');
    expect(grid.textContent).toContain('Owner');
    expect(grid.textContent).toContain('@Ada');
    // …and NOT Memories. The count is gone because it counted a column 084
    // emptied; asserting its ABSENCE is what stops it being re-added as a
    // "missing field" by someone reading the oracle frame alone.
    expect(grid.textContent).not.toContain('Memories');

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

// ---------------------------------------------------------------------------

/**
 * THE WIRING, now that it exists. The block lists above were written as an
 * EXPECTATION while the registry rows carried none — the handover's own note
 * says its registry-seam test "passes vacuously" until §4.2 lands. These make
 * it load-bearing: the constants at the top of this file and the registry rows
 * are now asserted equal, so the screens cannot silently drift from what these
 * tests prove about them.
 */
describe('the registry rows carry the block lists these tests assert', () => {
  const rowFor = (kind: string) => {
    const row = allKinds().find((r) => r.kind === kind);
    if (!row) throw new Error(`registry must carry a ${kind} row`);
    return row;
  };

  it('the member row draws the human frame', () => {
    expect(rowFor('member').panel.blocks).toEqual(MEMBER_BLOCKS);
  });

  it('the teammate row draws the agent frame, then the org tree', () => {
    // The oracle frame is intact and CONTIGUOUS; the org tree is appended,
    // which is exactly the claim the registry comment makes.
    expect(rowFor('team_member').panel.blocks).toEqual([
      ...AGENT_BLOCKS,
      { block: 'org-tree', label: 'TEAM' },
    ]);
  });

  it('teammates can be viewed as a tree, because the hierarchy IS the org tree', () => {
    // db/migrations/002_identity.sql:110. A hidden tree mode was the reason
    // the team structure was unreachable, so this asserts the un-hiding.
    const row = rowFor('team_member');
    expect(row.hiddenModes ?? []).not.toContain('tree');
    expect(row.list.tree).toEqual({ by: 'hierarchy', guideLines: true });
  });
});

/**
 * THE ORG TREE BLOCK — read-only, and honest when there is no structure.
 *
 * The interesting case is the LAST one. A teammate with no leader and no
 * reports is the common state of a team nobody has arranged, and drawing a
 * lone node there would imply structure was measured and found empty. It says
 * so in words instead.
 */
describe('org-tree block', () => {
  const ORG_BLOCKS: readonly ProfileBlockRef[] = [{ block: 'org-tree', label: 'TEAM' }];

  const withHierarchy = (
    id: string,
    parent: unknown,
    children: readonly unknown[],
    total?: number,
  ) => {
    const base = detailOf(id);
    return {
      ...base,
      hierarchy: {
        parent: parent ?? null,
        children: { items: children, nextCursor: null, ...(total == null ? {} : { total }) },
        path: parent ? [parent] : [],
      },
    } as React.ComponentProps<typeof ProfileBody>['detail'];
  };

  it('draws leader, this teammate, then reports — each naming its relation in words', () => {
    const detail = withHierarchy(teamMemberForge.id, memberAda, [teamMemberScout]);
    const { getByTestId } = render(<ProfileBody detail={detail} blocks={ORG_BLOCKS} now={NOW} />);

    const block = getByTestId('block-org-tree');
    expect(block.textContent).toContain(memberAda.title);
    expect(block.textContent).toContain(teamMemberScout.title);
    // The relation is never carried by indent alone.
    expect(block.textContent).toContain('leads');
    expect(block.textContent).toContain('this teammate');
    expect(block.textContent).toContain('reports to');
  });

  it('does not render the current teammate as a link to itself', () => {
    const detail = withHierarchy(teamMemberForge.id, memberAda, [teamMemberScout]);
    const { container } = render(<ProfileBody detail={detail} blocks={ORG_BLOCKS} now={NOW} />);

    const self = container.querySelector('.pn-profile__org-row--self');
    expect(self).toBeTruthy();
    // A control that looks live and does nothing is the defect being avoided.
    expect(self?.tagName).toBe('DIV');
    expect(self?.getAttribute('aria-current')).toBe('true');
  });

  it('states when the server holds more reports than were loaded', () => {
    const detail = withHierarchy(teamMemberForge.id, memberAda, [teamMemberScout], 4);
    const { getByTestId } = render(<ProfileBody detail={detail} blocks={ORG_BLOCKS} now={NOW} />);
    expect(getByTestId('block-org-tree').textContent).toContain('1 of 4 reports loaded');
  });

  it('says so plainly when the teammate has no leader and no reports', () => {
    const detail = withHierarchy(teamMemberForge.id, null, []);
    const { getByTestId } = render(<ProfileBody detail={detail} blocks={ORG_BLOCKS} now={NOW} />);

    const text = getByTestId('block-org-tree').textContent ?? '';
    expect(text).toContain('No leader and no reports');
    // It names what would change the picture, rather than only reporting empty.
    expect(text).toContain('parent');
  });
});

// ---------------------------------------------------------------------------

/**
 * THE WORKING SET — and the one thing this block exists to say.
 *
 * A list of remembered memories is easy and nearly useless. The fact that
 * matters is that BEING REMEMBERED AND BEING INJECTED ARE DIFFERENT:
 * `execution-handlers.ts:162` skips superseded rows when it builds a spawn's
 * working set (`if (!r.remembered || r.superseded) continue;`) while the
 * `remembers` edge survives untouched. So a teammate's set genuinely contains
 * memories no session will ever receive.
 *
 * A block that drew every row alike would tell the reader this teammate carries
 * context it does not carry — which is the same defect class as a `running`
 * badge over a dead session, just quieter. These tests hold that line.
 */
const MEMORY_BLOCK: readonly ProfileBlockRef[] = [
  {
    block: 'memory-set',
    label: 'MEMORIES',
    params: { edgeType: 'remembers', direction: 'outgoing', dstKind: 'memory', count: true },
  },
];

describe('the memory working set separates remembered from injected', () => {
  it('draws one row per remembers edge and counts them on the eyebrow', () => {
    const { getAllByTestId, getByTestId } = renderBody(teamMemberForge.id, MEMORY_BLOCK);
    const rows = getAllByTestId('memory-row');
    expect(rows).toHaveLength(3);
    // The count is of the very list below it, so the two cannot disagree.
    expect(getByTestId('block-memory-set').textContent).toContain('MEMORIES · 3');
  });

  it('marks the superseded memory NOT INJECTED and leaves the others alone', () => {
    const { getAllByTestId } = renderBody(teamMemberForge.id, MEMORY_BLOCK);
    const rows = getAllByTestId('memory-row');

    const dropped = rows.filter((row) => row.dataset.injected === 'no');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.textContent).toContain('Panels have a border-box reset');
    // In WORDS, not by tint alone — the strike-through is the third carrier.
    expect(dropped[0]?.textContent).toContain('not injected');
    expect(dropped[0]?.textContent).toContain('superseded');

    // …and nothing else is struck. A block that marked everything would pass
    // the assertion above while saying something false.
    expect(rows.filter((row) => row.dataset.injected === 'yes')).toHaveLength(2);
  });

  it('never claims "verified" — an unflagged memory says unflagged', () => {
    /*
     * The divergence recorded in domain/memory.ts: `badges.staleness` is
     * dropped entirely when nothing is wrong (entity-read.ts:1326), so a
     * verified memory and an unexamined one are identical on the wire. Drawing
     * a positive verification here would be authority nobody measured.
     */
    const { getByTestId } = renderBody(teamMemberForge.id, MEMORY_BLOCK);
    const block = getByTestId('block-memory-set');
    expect(block.textContent).toContain('unflagged');
    expect(block.textContent).not.toContain('verified');
  });

  it('renders the set READ-ONLY when the host wires no authoring', () => {
    // Absent authoring must not draw dead controls — a forget button that does
    // nothing is worse than no button, because it claims the write exists.
    const { queryByTestId } = renderBody(teamMemberForge.id, MEMORY_BLOCK);
    expect(queryByTestId('memory-forget')).toBeNull();
    expect(queryByTestId('memory-add')).toBeNull();
  });

  it('hands the EDGE id to forget, never the memory id', () => {
    /*
     * `edges.delete` is addressed by the edge's own id, and the memory entity
     * must survive: it is the target of other actors' append-only marks, so
     * deleting the claim because one holder stopped tracking it would destroy
     * other people's evidence.
     */
    const forgotten: string[] = [];
    const { getAllByTestId } = renderBody(teamMemberForge.id, MEMORY_BLOCK, {
      memoryAuthoring: {
        onAdd: () => undefined,
        onForget: (edgeId) => forgotten.push(edgeId),
      },
    });
    getAllByTestId('memory-forget')[0]?.click();
    expect(forgotten).toEqual(['edge-remembers-1']);
  });

  it('refuses authoring WITH A REASON rather than hiding the controls', () => {
    const { getByTestId } = renderBody(teamMemberForge.id, MEMORY_BLOCK, {
      memoryAuthoring: {
        onAdd: () => undefined,
        onForget: () => undefined,
        refusal: 'the node refuses edits to this entity',
      },
    });
    const add = getByTestId('memory-add');
    // Focusable and titled — the reason is unreachable if the control is not.
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(add.getAttribute('title')).toContain('refuses edits');
    expect(add.tagName).toBe('BUTTON');
  });
});

// ---------------------------------------------------------------------------

/**
 * THE MEMORY DETAIL — the profile archetype's third frame.
 *
 * It is here rather than in a MemoryBody because there is no MemoryBody and
 * there must not be: this body's contract is that anatomy is the registry's
 * ordered block list and no code asks what the entity IS. The memory row is
 * the proof — it reuses `bio` and `field-grid` unchanged and adds two blocks
 * that are themselves kind-free.
 */
const MEMORY_PANEL = getKind('memory').panel.blocks ?? [];

describe('the memory detail is a registry row, not a new body', () => {
  it('renders the memory frame from the registry row alone', () => {
    const { getByTestId } = renderBody(memoryTokens.id, MEMORY_PANEL as ProfileBlockRef[]);
    // The claim as prose — `statement` is the one 056 field that is content.
    expect(getByTestId('block-bio').textContent).toContain('tokens.css is verbatim');
    // The scope, read from STATE, which is why it needs no second fetch.
    const grid = getByTestId('block-field-grid').textContent ?? '';
    expect(grid).toContain('Ranges over');
    expect(grid).toContain('packages/tm8-ui/src/styles/tokens.css');
    expect(grid).toContain('Measured by');
    // The field 056 made required so a memory cannot be over-applied.
    expect(grid).toContain('Does not establish');
    expect(grid).toContain('that the token VALUES are correct');
  });

  it('states UNFLAGGED with the verified caveat rather than implying a clean bill', () => {
    const { getByTestId, queryByTestId } = renderBody(memoryTokens.id, MEMORY_PANEL as ProfileBlockRef[]);
    expect(queryByTestId('epistemics-reasons')).toBeNull();
    const text = getByTestId('epistemics-unflagged').textContent ?? '';
    expect(text).toContain('not the same as verified');
    // The mechanism of the blindness is named, not just asserted.
    expect(text).toContain('omits the badge entirely');
  });

  it('lists EVERY reason, not just the headline the row shows', () => {
    const { getByTestId } = renderBody(memorySuperseded.id, MEMORY_PANEL as ProfileBlockRef[]);
    const reasons = getByTestId('epistemics-reasons').textContent ?? '';
    expect(reasons).toContain('superseded');
    // …and it says what superseded MEANS for injection, which is the fact a
    // reader opened this panel to find.
    expect(reasons).toContain('drops it from working sets');
  });

  it('names the disputes it carries with their open count', () => {
    const { getByTestId } = renderBody(memoryDisputed.id, MEMORY_PANEL as ProfileBlockRef[]);
    const reasons = getByTestId('epistemics-reasons').textContent ?? '';
    expect(reasons).toContain('disputed');
    expect(reasons).toContain('2 open dispute');
    // Still injected — a dispute marks, it does not withhold.
    expect(reasons).toContain('Still injected');
  });

  it('says marking is UNWIRED rather than hiding the verbs', () => {
    // Hiding them would claim the memory cannot be marked, which is false.
    const { queryByTestId, getByTestId } = renderBody(memoryTokens.id, MEMORY_PANEL as ProfileBlockRef[]);
    expect(queryByTestId('memory-mark-supersede')).toBeNull();
    expect(getByTestId('block-epistemics').textContent).toContain('not wired on this surface');
  });

  it('offers both marks, each carrying its permanence BEFORE the click', () => {
    const marks: string[] = [];
    const { getByTestId } = renderBody(memoryTokens.id, MEMORY_PANEL as ProfileBlockRef[], {
      onMarkMemory: (mark) => marks.push(mark),
    });
    const supersede = getByTestId('memory-mark-supersede');
    // Both edges are append_only — the form must not be where you find out.
    expect(supersede.getAttribute('title')).toContain('append-only');
    expect(getByTestId('memory-mark-dispute').getAttribute('title')).toContain('append-only');
    supersede.click();
    getByTestId('memory-mark-dispute').click();
    expect(marks).toEqual(['supersede', 'dispute']);
  });

  it('lists holders by KIND and keeps authorship in its own block', () => {
    /*
     * 085 made `remembers` a mixed-kind list, so the kind is the only thing
     * distinguishing a teammate holder from a task or a session one. Authorship
     * is NOT derived from that kind — it is the separate `authored_from` edge,
     * which is why the two are separate blocks and the second says so when the
     * edge is absent rather than guessing from the first.
     */
    const { getAllByTestId } = renderBody(memoryTokens.id, MEMORY_PANEL as ProfileBlockRef[]);
    const [holders] = getAllByTestId('peer-rows');
    expect(holders?.textContent).toContain('forge');
    expect(holders?.textContent).toContain('Teammate');
  });

  it('says what an EMPTY holder list means for injection', () => {
    const { getByTestId } = renderBody(memoryDisputed.id, [
      {
        block: 'peer-rows',
        label: 'REMEMBERED BY',
        params: { edgeType: 'authored_from', direction: 'outgoing', empty: 'No authoring session recorded.' },
      },
    ]);
    // An absence stated, with the consequence named — never a blank region.
    expect(getByTestId('block-peer-rows').textContent).toContain('No authoring session recorded.');
  });
});

/*
 * THE LOOP DETAIL used to be the profile archetype's fourth frame. It moved to
 * `loops/loop-controls.test.tsx` with the panel itself: a loop's body follows
 * its VERBS, and `loop-controls` mutates, so the kind is `generic` — the only
 * archetype handed a command executor. Every fact those tests asserted is
 * asserted there, against the blocks the registry actually ships.
 */
