// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  CollabError,
  type EntityCapabilities,
  type EntityDetail,
  type EntityHeaderResult,
  type EntityHeaderView,
} from '@tm8/contract';
import { getKind, headerAuthorable, REASONS as DOMAIN_REASONS, type ActionContext } from '../../domain';
import { FIXTURE_SPACE_ID, docLayoutSpec, fixtureDetails, presenceHollowReason } from '../../fixtures';
import { EntityDetailPanel, type DetailReasons } from '../EntityDetailPanel';
import { HeaderSection } from './HeaderSection';

/**
 * I9a — the selection header section. Capabilities are WRITTEN OUT in every
 * detail here: the fixtures default to CAPS_FULL, which would silently claim
 * edit rights the test never meant to grant.
 */

const CAN_EDIT: EntityCapabilities = {
  canEdit: true, canDelete: false, canAddChild: false, canLink: false,
  canPull: false, canReact: false, canGrantPoints: false, canComplete: false,
};
const READ_ONLY: EntityCapabilities = { ...CAN_EDIT, canEdit: false };

const base = fixtureDetails[docLayoutSpec.id]!;

function doc(over: Partial<EntityDetail> = {}): EntityDetail {
  return { ...base, version: 5, capabilities: CAN_EDIT, ...over } as EntityDetail;
}

function authored(over: Partial<EntityHeaderView> = {}): EntityHeaderView {
  return {
    entityId: base.id,
    kind: 'doc',
    name: base.title,
    whenToUse: 'When laying out the panel grid',
    summary: 'The C_min formula and route grammar',
    keywords: ['layout', 'grid'],
    source: 'authored',
    stale: false,
    bytes: 2048,
    loadPointer: `tm8 entity get ${base.id}`,
    version: 3,
    pinnedVersion: 5,
    ...over,
  };
}

function resultWith(detail: EntityDetail, header: EntityHeaderView): EntityHeaderResult {
  return {
    entity: header.version > 0 ? { ...detail, header } : detail,
    patches: [],
    header,
  };
}

function commandsFor(detail: EntityDetail) {
  return {
    setEntityHeader: vi.fn(async (_id: string, input: { whenToUse?: string | null; summary?: string | null; keywords?: string[]; expectedVersion?: number }) =>
      resultWith(detail, authored({
        whenToUse: input.whenToUse ?? null,
        summary: input.summary ?? null,
        keywords: input.keywords ?? [],
        version: (input.expectedVersion ?? 0) + 1,
        pinnedVersion: detail.version,
      }))),
    clearEntityHeader: vi.fn(async () =>
      resultWith(detail, authored({ source: 'derived', version: 0, pinnedVersion: null, whenToUse: null, summary: 'derived', keywords: [] }))),
  };
}

describe('HeaderSection — reading', () => {
  it('says there is no header when none is authored, and offers to write one', () => {
    render(<HeaderSection detail={doc()} commands={commandsFor(doc())} />);
    expect(screen.getByTestId('header-none').textContent).toBe('No header: later launches see its derived summary.');
    expect(screen.getByTestId('header-source').textContent).toBe('not authored');
    expect(screen.getByTestId('header-edit').textContent).toBe('Write header');
    expect(screen.queryByTestId('header-clear')).toBeNull();
  });

  it('shows an authored header: both fields, keywords, source and body size', () => {
    const detail = doc({ header: authored() });
    render(<HeaderSection detail={detail} commands={commandsFor(detail)} />);
    expect(screen.getByTestId('header-when').textContent).toBe('When laying out the panel grid');
    expect(screen.getByTestId('header-summary').textContent).toBe('The C_min formula and route grammar');
    expect(screen.getByTestId('header-keywords').textContent).toBe('layoutgrid');
    expect(screen.getByTestId('header-source').textContent).toBe('authored');
    expect(screen.getByTestId('header-bytes').textContent).toBe('body 2 KB');
    expect(screen.queryByTestId('header-stale')).toBeNull();
    expect(screen.queryByTestId('header-mark-current')).toBeNull();
  });

  it('renders header text as TEXT — markup in it never becomes elements', () => {
    const hostile = '<img src=x onerror="alert(1)"> **bold** [link](javascript:alert(1))';
    const detail = doc({ header: authored({ whenToUse: hostile, summary: '<script>alert(1)</script>' }) });
    const { container } = render(<HeaderSection detail={detail} commands={commandsFor(detail)} />);
    expect(screen.getByTestId('header-when').textContent).toBe(hostile);
    expect(container.querySelector('img, script, a, strong')).toBeNull();
  });

  it('marks a stale header with both versions', () => {
    const detail = doc({ version: 7, header: authored({ stale: true, pinnedVersion: 4 }) });
    render(<HeaderSection detail={detail} commands={commandsFor(detail)} />);
    expect(screen.getByTestId('header-stale').textContent).toBe('stale · written for v4, body is now v7');
  });

  it('reads the version drift itself when the detail moved on after the header was read', () => {
    // The server said fresh at read time; an edit bumped the entity since.
    const detail = doc({ version: 6, header: authored({ stale: false, pinnedVersion: 5 }) });
    render(<HeaderSection detail={detail} commands={commandsFor(detail)} />);
    expect(screen.getByTestId('header-stale').textContent).toBe('stale · written for v5, body is now v6');
  });

  it('a revision-stale header (same entity version) says so without inventing a number', () => {
    const detail = doc({ version: 5, header: authored({ stale: true, pinnedVersion: 5 }) });
    render(<HeaderSection detail={detail} commands={commandsFor(detail)} />);
    expect(screen.getByTestId('header-stale').textContent).toBe('stale · written for an earlier revision of the body');
  });
});

describe('HeaderSection — writing', () => {
  it('saves with the HEADER version as expectedVersion, blank fields as null, keywords split', async () => {
    const detail = doc({ header: authored({ version: 3 }) });
    const commands = commandsFor(detail);
    const onSaved = vi.fn();
    render(<HeaderSection detail={detail} commands={commands} onSaved={onSaved} />);
    fireEvent.click(screen.getByTestId('header-edit'));
    fireEvent.change(screen.getByTestId('header-input-when'), { target: { value: '  Open for layout work  ' } });
    fireEvent.change(screen.getByTestId('header-input-summary'), { target: { value: '   ' } });
    fireEvent.change(screen.getByTestId('header-input-keywords'), { target: { value: 'grid, , layout,grid' } });
    fireEvent.click(screen.getByTestId('header-save'));
    await waitFor(() => expect(commands.setEntityHeader).toHaveBeenCalledTimes(1));
    expect(commands.setEntityHeader).toHaveBeenCalledWith(detail.id, {
      whenToUse: 'Open for layout work',
      summary: null,
      keywords: ['grid', 'layout'],
      expectedVersion: 3,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // The result is shown even before the host hands in a new detail.
    expect(screen.getByTestId('header-when').textContent).toBe('Open for layout work');
    expect(screen.queryByTestId('header-summary')).toBeNull();
  });

  it('a first header is written against version 0', async () => {
    const detail = doc();
    const commands = commandsFor(detail);
    render(<HeaderSection detail={detail} commands={commands} />);
    fireEvent.click(screen.getByTestId('header-edit'));
    fireEvent.change(screen.getByTestId('header-input-summary'), { target: { value: 'The spec' } });
    fireEvent.click(screen.getByTestId('header-save'));
    await waitFor(() => expect(commands.setEntityHeader).toHaveBeenCalledTimes(1));
    expect(commands.setEntityHeader.mock.calls[0]![1].expectedVersion).toBe(0);
    await waitFor(() => expect(screen.getByTestId('header-source').textContent).toBe('authored'));
  });

  it('LENIENT: past the guidance the count turns, and Save stays enabled', () => {
    const detail = doc();
    render(<HeaderSection detail={detail} commands={commandsFor(detail)} />);
    fireEvent.click(screen.getByTestId('header-edit'));
    fireEvent.change(screen.getByTestId('header-input-when'), { target: { value: 'x'.repeat(450) } });
    const count = screen.getByTestId('header-input-when-count');
    expect(count.textContent).toBe('450 · aim for ≤ 400');
    expect(count.className).toContain('pn-header__hint--over');
    const save = screen.getByTestId('header-save') as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(save.getAttribute('aria-disabled')).toBeNull();
  });

  it("shows the server's refusal inline, in its own words, and keeps the text", async () => {
    const detail = doc();
    const commands = commandsFor(detail);
    commands.setEntityHeader.mockRejectedValueOnce(new CollabError('invalid_input', 'whenToUse must be at most 400 characters'));
    render(<HeaderSection detail={detail} commands={commands} />);
    fireEvent.click(screen.getByTestId('header-edit'));
    fireEvent.change(screen.getByTestId('header-input-when'), { target: { value: 'y'.repeat(500) } });
    fireEvent.click(screen.getByTestId('header-save'));
    const alert = await screen.findByTestId('header-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('whenToUse must be at most 400 characters');
    expect((screen.getByTestId('header-input-when') as HTMLTextAreaElement).value).toBe('y'.repeat(500));
  });

  it('Mark current re-saves the SAME text against the header version', async () => {
    const header = authored({ stale: true, pinnedVersion: 4, version: 2 });
    const detail = doc({ version: 7, header });
    const commands = commandsFor(detail);
    render(<HeaderSection detail={detail} commands={commands} />);
    fireEvent.click(screen.getByTestId('header-mark-current'));
    await waitFor(() => expect(commands.setEntityHeader).toHaveBeenCalledTimes(1));
    expect(commands.setEntityHeader).toHaveBeenCalledWith(detail.id, {
      whenToUse: header.whenToUse,
      summary: header.summary,
      keywords: header.keywords,
      expectedVersion: 2,
    });
    await waitFor(() => expect(screen.queryByTestId('header-stale')).toBeNull());
  });

  it('shows the node\'s warnings as a note after a no-op save (lenient: nothing is refused for content)', async () => {
    const detail = doc({ header: authored() });
    const commands = commandsFor(detail);
    commands.setEntityHeader.mockResolvedValueOnce({
      ...resultWith(detail, authored()),
      warnings: [{ code: 'header_empty', message: 'The header was empty after trimming; nothing was written.' }],
    });
    render(<HeaderSection detail={detail} commands={commands} />);
    fireEvent.click(screen.getByTestId('header-edit'));
    fireEvent.change(screen.getByTestId('header-input-when'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('header-input-summary'), { target: { value: '' } });
    expect(screen.getByTestId('header-blank-note')).toBeTruthy();
    fireEvent.click(screen.getByTestId('header-save'));
    const note = await screen.findByTestId('header-notice');
    expect(note.textContent).toBe('The header was empty after trimming; nothing was written.');
    expect(screen.getByTestId('header-when').textContent).toBe('When laying out the panel grid');
  });

  it('a CLIPPED read: says so, refuses Mark current (it would cut the stored text), warns in the editor', () => {
    const detail = doc({ version: 7, header: authored({ stale: true, pinnedVersion: 4, clipped: ['summary'] }) });
    const commands = commandsFor(detail);
    render(<HeaderSection detail={detail} commands={commands} />);
    expect(screen.getByTestId('header-clipped').textContent).toContain('summary');
    expect(screen.queryByTestId('header-mark-current')).toBeNull();
    expect(screen.getByTestId('header-section').textContent).toContain('This read shows the header shortened');
    fireEvent.click(screen.getByTestId('header-edit'));
    expect(screen.getByTestId('header-clipped-note').textContent).toContain('Saving writes exactly what is in these fields');
    expect(commands.setEntityHeader).not.toHaveBeenCalled();
  });

  it('a result with NO header (a kind that stores none) falls back to "no header"', async () => {
    const detail = doc({ header: authored() });
    const commands = commandsFor(detail);
    commands.setEntityHeader.mockResolvedValueOnce({ entity: detail, patches: [], warnings: [{ code: 'header_not_stored', message: 'not stored' }] });
    render(<HeaderSection detail={detail} commands={commands} />);
    fireEvent.click(screen.getByTestId('header-edit'));
    fireEvent.click(screen.getByTestId('header-save'));
    await screen.findByTestId('header-none');
    expect(screen.getByTestId('header-notice').textContent).toBe('not stored');
  });

  it('Clear sends the header version and falls back to "no header"', async () => {
    const detail = doc({ header: authored({ version: 4 }) });
    const commands = commandsFor(detail);
    render(<HeaderSection detail={detail} commands={commands} />);
    fireEvent.click(screen.getByTestId('header-clear'));
    await waitFor(() => expect(commands.clearEntityHeader).toHaveBeenCalledWith(detail.id, { expectedVersion: 4 }));
    await screen.findByTestId('header-none');
  });

  it('without edit rights the verb is disabled WITH a reason, never hidden', () => {
    const detail = doc({ capabilities: READ_ONLY, header: authored() });
    render(<HeaderSection detail={detail} commands={commandsFor(detail)} />);
    expect(screen.queryByTestId('header-edit')).toBeNull();
    const disabled = screen.getByTestId('disabled-with-reason');
    expect(disabled.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('header-section').textContent).toContain('You cannot edit this entity');
    // Reading is unaffected.
    expect(screen.getByTestId('header-when')).toBeTruthy();
  });

  it('an unwired host says so rather than drawing a live control', () => {
    render(<HeaderSection detail={doc()} commands={null} />);
    expect(screen.getByTestId('disabled-with-reason').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('header-section').textContent).toContain('Header writes are not wired here');
  });
});

describe('the panel mounts it on the Connections tab, for header kinds only', () => {
  const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
  const reasons: DetailReasons = {
    presenceHollow: presenceHollowReason,
    versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
    provenanceHollow: 'n/a',
    shareUnavailable: 'n/a',
    withdrawUnavailable: 'n/a',
  };

  const kinds = Object.values(fixtureDetails).filter((d) => d.deletedAt == null);
  const withHeader = kinds.find((d) => headerAuthorable(d.kind));
  const without = kinds.filter((d) => !headerAuthorable(d.kind));

  it('the walk has both sides (a walk over nothing proves nothing)', () => {
    expect(withHeader).toBeDefined();
    expect(without.length).toBeGreaterThan(3);
  });

  it('a header kind gets the section', () => {
    render(
      <EntityDetailPanel detail={{ ...withHeader!, capabilities: CAN_EDIT }} reasons={reasons} ctx={ctx} activeTab="connections" />,
    );
    expect(screen.getByTestId('header-section')).toBeTruthy();
  });

  it.each(without.map((d) => [d.kind, d] as const))('%s does not', (_kind, detail) => {
    render(<EntityDetailPanel detail={{ ...detail, capabilities: CAN_EDIT }} reasons={reasons} ctx={ctx} activeTab="connections" />);
    expect(screen.queryByTestId('header-section')).toBeNull();
  });

  it('every kind that offers a header on create can carry one', () => {
    const offering = Object.values(fixtureDetails).map((d) => getKind(d.kind)).filter((c) => c.createHeader);
    expect(offering.length).toBeGreaterThan(0);
    for (const config of offering) expect(headerAuthorable(config.kind)).toBe(true);
  });
});
