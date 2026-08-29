// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { getKind } from '../../domain';
import { docLayoutSpec, fixtureDetails, profileHouseStyle, taskGuideLines } from '../../fixtures';
import { RESTRICTED_BLOCKS, RestrictedBody, type RestrictedBlockRef } from './RestrictedBody';

/**
 * THE RESTRICTED ARCHETYPE — T0-4 "Governed & fallback kinds", the INTERACTION
 * PROFILE card (oracle 714–762).
 *
 * These assertions pin what a render cannot show you, and each one is a way
 * this body could be wrong while looking right:
 *
 *   1. NO STATUS LITERALS. The lifecycle words and their banner sentences are
 *      registry DATA keyed by the status the entity carries. A body that knew
 *      the three words would need an edit for a fourth — and worse, would
 *      disagree with the registry the day one of them is renamed.
 *   2. ACTIVE DRAWS NO BANNER — and that must be because no sentence is
 *      declared for it, not because a literal was special-cased. The chrome
 *      already renders the status pill; a second one here is D64's defect.
 *   3. A REGION WITH NO SOURCE STATES ITS ABSENCE. The oracle's preview prose
 *      has no member on the contract's content for this kind and no seam read
 *      behind it; rendering blank would read as a broken panel, and inventing
 *      text would be worse.
 *   4. A DECLARED FIELD THAT IS ABSENT KEEPS ITS ROW. "No risk policy" and
 *      "nobody asked about risk" are different facts.
 *   5. MISSING ≠ EMPTY on the chip list. One is unread; the other is a real
 *      zero, and only the second may say "not the default anywhere".
 *
 * Contract types are IMPORTED and nothing here casts a shape.
 */

// ---------------------------------------------------------------------------

function profileDetail(over: Partial<EntityDetail> = {}): EntityDetail {
  const base = fixtureDetails[profileHouseStyle.id];
  if (!base) throw new Error('fixtures must supply a restricted detail');
  return { ...base, ...over };
}

/** The server withholding the two capabilities this kind's row has copy for. */
function withheld(): EntityDetail {
  const base = profileDetail();
  return { ...base, capabilities: { ...base.capabilities, canEdit: false, canDelete: false } };
}

/** Re-states the entity's lifecycle value without re-authoring the shape. */
function withStatus(status: string): EntityDetail {
  const base = profileDetail();
  return {
    ...base,
    state: { ...base.state, status } as EntityDetail['state'],
    content: { ...base.content, status } as EntityDetail['content'],
  };
}

/**
 * The anatomy the oracle draws, as the registry would declare it. The banner
 * sentences are the ORACLE's own bytes (lines 736, 739); `active` is
 * deliberately absent, which is how the canvas draws it.
 */
const BLOCKS: readonly RestrictedBlockRef[] = [
  {
    block: 'status-banner',
    params: {
      source: 'status',
      draft: 'preview only — activate to offer it at launch.',
      retired: 'sessions pinned to it keep running — new launches can’t pick it.',
    },
  },
  { block: 'preview', label: 'PREVIEW' },
  { block: 'field-rows', params: { fields: 'voice=VOICE,risk=RISK,tools=TOOLS' } },
  { block: 'items', label: 'DEFAULT FOR', params: { source: 'defaultFor' } },
  { block: 'restrictions' },
  { block: 'pin-provenance', params: { countSource: 'pinnedBy' } },
];

function renderBody(over: Partial<React.ComponentProps<typeof RestrictedBody>> = {}) {
  return render(<RestrictedBody detail={profileDetail()} blocks={BLOCKS} {...over} />);
}

// ---------------------------------------------------------------------------

describe('the block vocabulary is the registry seam', () => {
  it('exports the block names, so a registry row can be checked against them', () => {
    expect([...RESTRICTED_BLOCKS]).toEqual([
      'status-banner',
      'preview',
      'field-rows',
      'items',
      'restrictions',
      'pin-provenance',
      'notice',
    ]);
  });

  it('renders NOTHING for a block name it does not know', () => {
    const { getByTestId } = renderBody({ blocks: [{ block: 'not-a-block' }] });
    expect(getByTestId('restricted-body').children).toHaveLength(0);
  });

  it('renders the designed empty body when the registry row declares no blocks', () => {
    const { getByTestId } = renderBody({ blocks: [] });
    expect(getByTestId('restricted-body').textContent).toContain('universal fields only');
  });

  it('renders the blocks in the declared order', () => {
    const draft = withStatus('draft');
    const { getByTestId } = renderBody({
      detail: { ...draft, capabilities: { ...draft.capabilities, canEdit: false, canDelete: false } },
    });
    const order = Array.from(getByTestId('restricted-body').children).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(order).toEqual([
      'restricted-banner',
      'restricted-preview',
      'restricted-fields',
      'restricted-items',
      'restricted-restrictions',
      'restricted-provenance',
    ]);
  });
});

describe('the lifecycle banner is registry data, not three known words', () => {
  it('renders the DRAFT sentence with the registry’s own tone', () => {
    const { getByTestId } = renderBody({ detail: withStatus('draft') });
    const banner = getByTestId('restricted-banner');
    expect(banner.getAttribute('data-status')).toBe('draft');
    expect(banner.textContent).toContain('preview only — activate to offer it at launch.');
    // The tone comes from the SAME registry spec the chrome pill reads.
    const tones = getKind(profileHouseStyle.kind).panel.statusPill?.tones ?? {};
    expect(banner.getAttribute('data-tone')).toBe(tones.draft);
  });

  it('renders the RETIRED sentence', () => {
    const { getByTestId } = renderBody({ detail: withStatus('retired') });
    expect(getByTestId('restricted-banner').textContent).toContain('sessions pinned to it keep running');
  });

  it('draws NO banner for a state the registry declares no sentence for', () => {
    // The oracle's active card goes straight to PREVIEW, and the chrome
    // already carries the status word — a bare pill here would be D64.
    const { queryByTestId } = renderBody({ detail: withStatus('active') });
    expect(queryByTestId('restricted-banner')).toBeNull();
  });

  it('honours a status the component has never heard of', () => {
    // The proof that no status literal lives in this file: a value invented
    // by the registry renders with its sentence and nothing breaks.
    const { getByTestId } = renderBody({
      detail: withStatus('quarantined'),
      blocks: [
        { block: 'status-banner', params: { source: 'status', quarantined: 'held pending review.' } },
      ],
    });
    const banner = getByTestId('restricted-banner');
    expect(banner.getAttribute('data-status')).toBe('quarantined');
    expect(banner.textContent).toContain('held pending review.');
  });

  it('states the absence when the block is declared and the entity carries no status', () => {
    const base = profileDetail();
    const stateless: EntityDetail = {
      ...base,
      state: { ...base.state, status: undefined } as unknown as EntityDetail['state'],
      content: { ...base.content, status: undefined } as unknown as EntityDetail['content'],
    };
    const { getByTestId } = renderBody({
      detail: stateless,
      blocks: [{ block: 'status-banner', params: { source: 'status' } }],
    });
    expect(getByTestId('restricted-banner-hollow').textContent).toContain('lifecycle');
  });
});

describe('the preview region', () => {
  it('states that no preview text is available, with its cause', () => {
    const { getByTestId } = renderBody();
    const region = getByTestId('restricted-preview');
    expect(region.textContent).toContain('PREVIEW');
    expect(getByTestId('restricted-preview-hollow').textContent).toContain(
      'no preview text is available',
    );
  });

  it('renders real prose the moment a member carries it', () => {
    const base = profileDetail();
    const withPreview: EntityDetail = {
      ...base,
      content: {
        ...base.content,
        preview: 'You are terse and evidence-first.',
      } as unknown as EntityDetail['content'],
    };
    const { getByTestId, queryByTestId } = renderBody({ detail: withPreview });
    expect(getByTestId('restricted-preview').textContent).toContain('You are terse and evidence-first.');
    expect(queryByTestId('restricted-preview-hollow')).toBeNull();
  });
});

describe('the field table', () => {
  it('keeps a declared row whose value is absent, rather than dropping it', () => {
    const { getByTestId } = renderBody();
    const table = getByTestId('restricted-fields');
    expect(table.textContent).toContain('VOICE');
    expect(table.textContent).toContain('RISK');
    expect(table.textContent).toContain('TOOLS');
    // Three declared rows, three rendered rows — none silently dropped.
    expect(table.children).toHaveLength(3);
  });

  it('reads a value off state or content when one exists', () => {
    const base = profileDetail();
    const withVoice: EntityDetail = {
      ...base,
      content: { ...base.content, voice: 'terse' } as unknown as EntityDetail['content'],
    };
    const { getByTestId } = renderBody({ detail: withVoice });
    expect(getByTestId('restricted-fields').textContent).toContain('terse');
  });

  it('renders nothing at all when the registry names no fields', () => {
    const { queryByTestId } = renderBody({ blocks: [{ block: 'field-rows' }] });
    expect(queryByTestId('restricted-fields')).toBeNull();
  });
});

describe('DEFAULT FOR — missing is not empty', () => {
  it('renders HOLLOW when the named member does not exist', () => {
    const { getByTestId } = renderBody();
    expect(getByTestId('restricted-items-hollow').textContent).toContain('not read');
  });

  it('renders a REAL ZERO as a real zero', () => {
    const base = profileDetail();
    const empty: EntityDetail = {
      ...base,
      content: { ...base.content, defaultFor: [] } as unknown as EntityDetail['content'],
    };
    const { getByTestId, queryByTestId } = renderBody({ detail: empty });
    expect(queryByTestId('restricted-items-hollow')).toBeNull();
    expect(getByTestId('restricted-items').textContent).toContain('Not the default anywhere');
  });

  it('renders chips DISABLED-WITH-REASON while no opener is wired', () => {
    const base = profileDetail();
    const withDefaults: EntityDetail = {
      ...base,
      content: {
        ...base.content,
        defaultFor: [taskGuideLines, docLayoutSpec],
      } as unknown as EntityDetail['content'],
    };
    const { getAllByTestId } = renderBody({ detail: withDefaults });
    expect(getAllByTestId('disabled-with-reason').length).toBeGreaterThanOrEqual(2);
  });

  it('is a real control the moment an opener is wired', () => {
    const onOpenEntity = vi.fn();
    const base = profileDetail();
    const withDefaults: EntityDetail = {
      ...base,
      content: { ...base.content, defaultFor: [taskGuideLines] } as unknown as EntityDetail['content'],
    };
    const { getByTestId } = renderBody({ detail: withDefaults, onOpenEntity });
    fireEvent.click(within(getByTestId('restricted-items')).getByRole('button'));
    expect(onOpenEntity).toHaveBeenCalledWith(taskGuideLines.id);
  });
});

describe('the refusals', () => {
  it('names each refused verb with the REGISTRY’s authored mechanism', () => {
    const reasons = getKind(profileHouseStyle.kind).panel.capabilityReasons ?? {};
    /*
     * SERVER TRUTH decides, and the shared fixture grants EVERYTHING
     * (`CAPS_FULL`) — including edit and delete on a kind whose registry row
     * exists to refuse them. That is a fixture gap, reported to the
     * coordinator rather than papered over here; the withholding is stated
     * locally so this assertion tests the component and not the fixture.
     */
    const { getByTestId } = renderBody({ detail: withheld() });
    const region = getByTestId('restricted-restrictions');
    expect(region.textContent).toContain('Edit');
    if (reasons.canEdit) expect(region.textContent).toContain(reasons.canEdit);
  });

  it('does NOT call a granted capability a restriction', () => {
    const base = profileDetail();
    const permitted: EntityDetail = {
      ...base,
      capabilities: { ...base.capabilities, canEdit: true, canDelete: true },
    };
    const { queryByTestId } = renderBody({ detail: permitted });
    expect(queryByTestId('restricted-restrictions')).toBeNull();
  });

  it('renders the CHECKING state, not a refusal, when permissions have not loaded', () => {
    // "We haven't asked yet" and "you may not" are different facts, and at a
    // glance the first read as the second is how a user concludes they lack a
    // permission they have.
    const base = profileDetail();
    const unloaded: EntityDetail = {
      ...base,
      capabilities: null as unknown as EntityDetail['capabilities'],
    };
    const { getByTestId, queryByTestId } = renderBody({ detail: unloaded });
    expect(queryByTestId('restricted-restrictions')).toBeNull();
    expect(getByTestId('restricted-restrictions-checking').textContent).toContain('refusals');
  });
});

describe('the pinned-immutability caption', () => {
  it('always states the law', () => {
    const { getByTestId } = renderBody();
    expect(getByTestId('restricted-provenance').textContent).toContain('immutable provenance');
  });

  it('never invents a count: a named source that does not resolve renders hollow', () => {
    const { getByTestId } = renderBody();
    const caption = getByTestId('restricted-provenance');
    expect(caption.textContent).toContain('pinned by');
    expect(caption.textContent).not.toContain('Pinned by 0');
  });

  it('renders the count when a source actually resolves', () => {
    const base = profileDetail();
    const pinned: EntityDetail = {
      ...base,
      content: { ...base.content, pinnedBy: 3 } as unknown as EntityDetail['content'],
    };
    const { getByTestId } = renderBody({ detail: pinned });
    expect(getByTestId('restricted-provenance').textContent).toContain('Pinned by 3 running sessions');
  });

  it('omits the count entirely when the registry names no source', () => {
    const { getByTestId } = renderBody({ blocks: [{ block: 'pin-provenance' }] });
    const caption = getByTestId('restricted-provenance');
    expect(caption.textContent).toContain('immutable provenance');
    expect(caption.textContent).not.toContain('pinned by');
  });
});

describe('archetype, not kind (§15.2)', () => {
  it('renders a DIFFERENT kind through the same component and the same blocks', () => {
    const other = fixtureDetails[docLayoutSpec.id];
    if (!other) throw new Error('fixtures must supply a second detail');
    const { getByTestId } = renderBody({ detail: other });
    expect(getByTestId('restricted-body')).toBeTruthy();
    expect(getByTestId('restricted-preview')).toBeTruthy();
  });
});
