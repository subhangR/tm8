// @vitest-environment jsdom
/**
 * T3-4 FILES + T3-5 NODE — the suite, and what each half of it is for.
 *
 * The single most important property asserted here is NOT that the screens
 * render. It is that NOTHING ON THEM PRETENDS. A dropzone that accepts a
 * dragged file and silently drops it, a "Back up now" that does nothing, an
 * "up 14d 6h" that was transcribed off a canvas — each of those would pass an
 * "every frame renders" suite in green, and each is the exact defect the
 * charter's R7 and T1-4's dash-not-zero law exist to prevent.
 *
 * So the load-bearing tests are:
 *   · THE VERB SWEEP — every terminal verb these screens draw is rendered
 *     disabled-with-reason, with its reason in the DOM. Adding a live control
 *     for an unwired act fails here.
 *   · THE NO-INVENTED-NUMBER SWEEP — a cold node room contains no digit that
 *     is not a real measurement.
 *
 * RED-FIRST RECORD (see HANDOVER §Red-first): both sweeps were run against a
 * deliberately broken tree before the fix, and both failed. A green that was
 * never red is a claim, not a measurement.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  FilesScreen,
  NodeRoom,
  staticNodePort,
  glyphFor,
  previewKindOf,
  formatSizeChip,
  formatSizeRow,
  failureWord,
  extensionOf,
  capSentence,
  rowFromEntity,
  rowFromAttachment,
  enrich,
  attachedFiles,
  ALL_FILES_NODE_REASONS,
  MISSING_FILE_OPS,
  type FileRow,
} from './index';
import {
  SPECIMEN_ATTACHED,
  SPECIMEN_BUBBLE,
  SPECIMEN_NODE_FACTS,
  SPECIMEN_NODE_FACTS_COLD,
  SPECIMEN_NODE_FACTS_DEGRADED,
  SPECIMEN_PROVIDERS,
  SPECIMEN_QUEUE,
} from './specimen';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// The model — pure, and the place the oracle's closed vocabularies are pinned
// ---------------------------------------------------------------------------

describe('model — the oracle’s closed vocabularies', () => {
  it('maps mime to the oracle’s FOUR glyphs and nothing else (L94)', () => {
    expect(glyphFor('image/png')).toBe('▦');
    expect(glyphFor('application/pdf')).toBe('❐');
    expect(glyphFor('text/plain')).toBe('▤');
    expect(glyphFor('text/markdown')).toBe('▤');
    expect(glyphFor('video/quicktime')).toBe('◇');
    expect(glyphFor('application/octet-stream')).toBe('◇');
    // The set is closed: every mime lands in one of four.
    const glyphs = new Set(
      ['image/gif', 'application/json', 'audio/wav', 'application/pdf', 'text/csv'].map(glyphFor),
    );
    for (const g of glyphs) expect(['▦', '❐', '▤', '◇']).toContain(g);
  });

  it('previewKind is about the TYPE, never about whether bytes are reachable', () => {
    expect(previewKindOf('image/jpeg')).toBe('image');
    expect(previewKindOf('APPLICATION/PDF')).toBe('pdf');
    expect(previewKindOf('text/x-log')).toBe('text');
    expect(previewKindOf('application/json')).toBe('text');
    expect(previewKindOf('video/mp4')).toBe('none');
  });

  it('has exactly three failure words, each with the oracle’s tone (L124)', () => {
    expect(failureWord('failed')).toEqual({ word: 'failed', tone: 'block' });
    // The one that matters: the record exists and the bytes do not — that is
    // a WAIT, not an error. Styling it red would tell the user something broke.
    expect(failureWord('missing')).toEqual({ word: 'missing from this node', tone: 'wait' });
    expect(failureWord('no-preview')).toEqual({ word: 'no preview', tone: 'idle' });
  });

  it('keeps the chip and row size voices apart (L76 vs L50)', () => {
    expect(formatSizeChip(1_258_291)).toBe('1.2M');
    expect(formatSizeChip(348_160)).toBe('340K');
    expect(formatSizeRow(1_258_291)).toBe('1.2 MB');
    expect(formatSizeRow(42_991_616)).toBe('41 MB');
  });

  it('never prints a size it does not have', () => {
    expect(formatSizeChip(null)).toBeNull();
    expect(formatSizeRow(undefined)).toBeNull();
    // A measured zero is still a measurement and prints.
    expect(formatSizeRow(0)).toBe('0 B');
  });

  it('names the extension from the NAME, and says so when there is none', () => {
    expect(extensionOf('session-recording.mov')).toBe('.mov');
    expect(extensionOf('Makefile')).toBeNull();
    expect(extensionOf('.gitignore')).toBeNull();
  });

  it('refuses to state a per-file cap it has not measured', () => {
    expect(capSentence(null)).toBeNull();
    expect(capSentence(26_214_400)).toBe('25 MB per file');
  });
});

describe('model — rows from contract shapes', () => {
  const actor = { id: 'a', kind: 'member' as const, displayName: 'ada', isAgent: false };
  const fileEntity = {
    id: 'f1',
    spaceId: 's',
    kind: 'file',
    title: 'shot.png',
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: 'T',
    createdAt: 'T',
    updatedAt: 'T',
    deletedAt: null,
    createdBy: actor,
    counters: {},
    state: { kind: 'file', name: 'shot.png', mimeType: 'image/png', sizeBytes: 340 },
    badges: {},
  } as never;

  it('reads a file row off a file entity’s own state', () => {
    const row = rowFromEntity(fileEntity);
    expect(row).toMatchObject({ fileEntityId: 'f1', name: 'shot.png', sizeBytes: 340 });
    expect(row?.attributedTo).toMatchObject({ id: 'a', displayName: 'ada', isAgent: false });
  });

  it('returns null for an entity that is not a file — no kind literal involved', () => {
    const task = { ...(fileEntity as object), state: { kind: 'task' } } as never;
    expect(rowFromEntity(task)).toBeNull();
  });

  it('a message attachment has NO size, and the row admits it', () => {
    const message = {
      state: { kind: 'message', author: actor },
      createdAt: 'T',
    } as never;
    const row = rowFromAttachment(
      { fileEntityId: 'f1', name: 'shot.png', mime: 'image/png' },
      message,
    );
    expect(row.sizeBytes).toBeNull();
  });

  it('enrich fills a null size from a known entity and INVENTS nothing otherwise', () => {
    const message = { state: { kind: 'message', author: actor }, createdAt: 'T' } as never;
    const known = rowFromAttachment({ fileEntityId: 'f1', name: 'shot.png', mime: 'image/png' }, message);
    const unknown = rowFromAttachment({ fileEntityId: 'zz', name: 'x.bin', mime: 'a/b' }, message);
    const [a, b] = enrich([known, unknown], [fileEntity]);
    expect(a!.sizeBytes).toBe(340);
    expect(b!.sizeBytes).toBeNull();
  });

  it('reads attached files off `attached_to` edges, either direction, deduped', () => {
    const edge = (id: string, source: unknown, target: unknown) => ({
      id,
      type: 'attached_to',
      source,
      target,
      props: {},
      createdBy: actor,
      createdAt: 'T',
      updatedAt: 'T',
    });
    const detail = {
      connections: {
        outgoing: [
          {
            type: 'attached_to',
            direction: 'outgoing',
            label: 'files',
            edges: [edge('e1', fileEntity, { state: { kind: 'task' } })],
          },
          { type: 'blocks', direction: 'outgoing', label: 'blocks', edges: [edge('e2', fileEntity, fileEntity)] },
        ],
        incoming: [
          {
            type: 'attached_to',
            direction: 'incoming',
            label: 'files',
            edges: [edge('e3', { state: { kind: 'task' } }, fileEntity)],
          },
        ],
        unresolvedHardDependencyCount: 0,
      },
    } as never;
    const rows = attachedFiles(detail);
    // One file, found from both directions, counted once. The `blocks` group
    // is ignored even though its peers ARE files — the edge type is the law.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fileEntityId).toBe('f1');
  });
});

// ---------------------------------------------------------------------------
// THE VERB SWEEP — the load-bearing test
// ---------------------------------------------------------------------------

/**
 * Every act these two screens draw that this build cannot perform. Each entry
 * is the visible text of a control; the sweep finds it and asserts it is a
 * refusal carrying a reason, not a live control.
 *
 * ADDING A ROW HERE IS THE POINT: if a future change wires one of these for
 * real, this list is where the change is declared, and the test flips from
 * "must be refused" to a deletion someone had to think about.
 */
const REFUSED_VERBS_FILES = [
  'Drop to attach to T-114',
  '＋ attach',
  'try again',
];

const REFUSED_VERBS_NODE = ['＋ Provider', 'test launch ▸', 'Back up now', 'Restore…'];

/**
 * EVERY occurrence, not the first. A screen with two providers draws two
 * "test launch ▸" controls, and a sweep that checked only one would pass a
 * build where the second was live — which is exactly the class of miss this
 * file exists to prevent.
 */
function assertRefused(text: string) {
  const nodes = screen.getAllByText(text);
  expect(nodes.length, `"${text}" must be on screen`).toBeGreaterThan(0);
  for (const node of nodes) {
    // Walk up to the refusal wrapper. `DisabledAction` puts the treatment on
    // the control element itself, so the node either IS it or sits inside it.
    const control = node.closest('[data-testid="disabled-with-reason"]');
    expect(control, `"${text}" must render disabled-with-reason`).not.toBeNull();
    expect(control!.getAttribute('aria-disabled')).toBe('true');
    // The reason must be IN THE DOM and wired for AT — a tooltip that only
    // exists on hover is a reason a keyboard user never receives.
    const describedBy = control!.getAttribute('aria-describedby');
    expect(describedBy, `"${text}" must describe its reason`).toBeTruthy();
    const reason = document.getElementById(describedBy!);
    expect(reason, `"${text}" reason element must exist`).not.toBeNull();
    expect(reason!.textContent!.trim().length).toBeGreaterThan(20);
    // Focusable: a natively-disabled control cannot be reached, so its reason
    // can never be read. That is why this treatment is aria-disabled instead.
    expect(control!.getAttribute('tabindex')).toBe('0');
  }
}

/** The named subsystem row — three of them share one testid. */
function subsystem(name: string): HTMLElement {
  const row = screen
    .getByTestId('node-room')
    .querySelector<HTMLElement>(`[data-subsystem="${name}"]`);
  expect(row, `subsystem row "${name}" must exist`).not.toBeNull();
  return row!;
}

/**
 * THE DATA SURFACE, with the EXPLANATIONS stripped.
 *
 * The distinction this makes, and why it is not a loophole: a fabricated
 * "up 14d 6h" is a claim about the node; the sentence "all 102 contract
 * operations were checked" is a claim about the CHECK, and it is true. The
 * law being tested is "no unmeasured number is presented as a measurement",
 * so the sweep looks at values and strips prose that explains why the values
 * are absent — the reason captions, the hidden AT text, and the notes.
 */
function dataSurfaceText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  const strip = [
    '[hidden]',
    '.hon-tip',
    '.hon-caption',
    '.hon-stat__caption',
    '.fn-note',
    '.fn-conc__note',
    '.fn-consent',
    '.fn-provider-empty__why',
    '.fn-legend',
  ];
  for (const selector of strip) {
    clone.querySelectorAll(selector).forEach((el) => el.remove());
  }
  // `title` carries the same caption text; drop it too.
  clone.querySelectorAll('[title]').forEach((el) => el.removeAttribute('title'));
  return clone.textContent ?? '';
}

describe('T3-4 — the verb sweep', () => {
  it('refuses every unwired act, with a reason a keyboard user can reach', () => {
    render(
      <FilesScreen
        destinationLabel="T-114"
        queue={SPECIMEN_QUEUE}
        bubble={SPECIMEN_BUBBLE}
        attached={SPECIMEN_ATTACHED}
      />,
    );
    for (const verb of REFUSED_VERBS_FILES) assertRefused(verb);
  });

  it('the dropzone is not a drop target, and does not silently swallow a file', () => {
    render(<FilesScreen destinationLabel="T-114" />);
    const zone = screen.getByTestId('dropzone');
    // Structural, not behavioural: there is no drop handler to fire. If one is
    // ever added it must arrive with an executor, and this assertion is where
    // that conversation starts.
    expect(zone.getAttribute('ondrop')).toBeNull();
    expect(within(zone).getByTestId('disabled-with-reason')).toBeTruthy();
  });

  it('every download control is a refusal until a resolver is supplied', () => {
    render(<FilesScreen destinationLabel="T-114" attached={SPECIMEN_ATTACHED} />);
    expect(screen.queryAllByTestId('download-link')).toHaveLength(0);
    // …and the refusals are actually there, not merely absent controls.
    expect(screen.queryAllByTestId('disabled-with-reason').length).toBeGreaterThan(0);
  });

  it('a supplied resolver turns EVERY download control real at once', () => {
    render(
      <FilesScreen
        destinationLabel="T-114"
        attached={SPECIMEN_ATTACHED}
        downloadHref={(id) => `/v2/files/${id}/download`}
      />,
    );
    const links = screen.getAllByTestId('download-link');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/^\/v2\/files\/.+\/download$/);
      expect(link.hasAttribute('download')).toBe(true);
    }
  });

  it('a resolver that declines ONE file refuses only that one', () => {
    render(
      <FilesScreen
        destinationLabel="T-114"
        attached={SPECIMEN_ATTACHED}
        downloadHref={(id) => (id === 'spec-file-mov' ? null : `/v2/files/${id}/download`)}
      />,
    );
    // Per FILE, not per count: the declined one offers no link anywhere on
    // the screen, and the others still do. Counting links would depend on how
    // many surfaces happen to draw the same file.
    const declined = within(screen.getByTestId('file-list'))
      .getByText('session-recording.mov')
      .closest('[data-testid="file-row"]')!;
    expect(within(declined as HTMLElement).queryByTestId('download-link')).toBeNull();
    expect(within(declined as HTMLElement).getByTestId('disabled-with-reason')).toBeTruthy();
    const list = screen.getByTestId('file-list');
    const allowed = within(list).getByText('layout-spec-v3.pdf').closest('[data-testid="file-row"]')!;
    expect(within(allowed as HTMLElement).getByTestId('download-link')).toBeTruthy();
  });
});

describe('T3-4 — the three failure words, on screen', () => {
  it('a failed upload states its cause and keeps a way forward — never a bare ✗', () => {
    render(<FilesScreen destinationLabel="T-114" queue={SPECIMEN_QUEUE} />);
    const row = screen.getByText('session-recording.mov').closest('[data-phase="failed"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('failed')).toBeTruthy();
    expect(within(row as HTMLElement).getByText(/over the 25 MB cap/)).toBeTruthy();
    expect(within(row as HTMLElement).getByText('try again')).toBeTruthy();
  });

  it('missing bytes are the WAIT word, and the row offers no download', () => {
    render(
      <FilesScreen
        destinationLabel="T-114"
        attached={SPECIMEN_ATTACHED}
        downloadHref={(id) => `/v2/files/${id}/download`}
      />,
    );
    const row = screen.getByText('bench-run.log').closest('[data-testid="file-row"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('missing from this node')).toBeTruthy();
    // Nothing to download, so nothing offering to.
    expect(within(row as HTMLElement).queryByTestId('download-link')).toBeNull();
    expect(row!.getAttribute('data-missing')).toBe('true');
  });

  it('an unpreviewable file says which extension, and downloads', () => {
    render(
      <FilesScreen
        destinationLabel="T-114"
        attached={SPECIMEN_ATTACHED}
        downloadHref={(id) => `/v2/files/${id}/download`}
      />,
    );
    const card = screen.getByTestId('no-preview');
    expect(within(card).getByText('No preview for .mov')).toBeTruthy();
    expect(within(card).getByTestId('download-link')).toBeTruthy();
  });
});

describe('T3-4 — reads that are real', () => {
  it('renders the message chips with agent provenance carried, not flattened', () => {
    render(
      <FilesScreen
        destinationLabel="T-114"
        bubble={{ ...SPECIMEN_BUBBLE, authorName: 'forge', authorIsAgent: true }}
      />,
    );
    const bubble = screen.getByTestId('message-bubble');
    // kit/Avatar encodes the shape law; the screen only has to pass the flag.
    expect(within(bubble).getByRole('img', { name: 'forge' }).className).toContain('kit-avatar--agent');
  });

  it('an entity with no attached files says a MEASURED zero, not a dash', () => {
    render(<FilesScreen destinationLabel="T-114" attached={[]} />);
    expect(screen.getByText('FILES · 0')).toBeTruthy();
    // The distinction that matters: connections WERE read and carried no
    // attached_to edge. A dash here would claim nobody looked.
    expect(screen.getByTestId('file-list-empty').textContent).toBe('No files attached to this entity.');
    expect(screen.getByTestId('file-list-empty').textContent).not.toContain('—');
  });

  it('a chip with no known size prints no size rather than 0', () => {
    const row: FileRow = {
      fileEntityId: 'x',
      name: 'x.bin',
      mime: 'application/octet-stream',
      sizeBytes: null,
      attributedTo: null,
      attributedAt: null,
      sourceMissing: false,
    };
    render(<FilesScreen destinationLabel="T" bubble={{ ...SPECIMEN_BUBBLE, files: [row] }} />);
    const chip = screen.getByTestId('file-chip');
    expect(chip.textContent).toContain('x.bin');
    expect(chip.textContent).not.toMatch(/\d/);
  });
});

describe('T3-4 — the preview overlay', () => {
  it('opens from a chip and closes on Esc (L118)', () => {
    render(<FilesScreen destinationLabel="T-114" bubble={SPECIMEN_BUBBLE} />);
    expect(screen.queryByTestId('preview-overlay')).toBeNull();
    fireEvent.click(screen.getAllByTestId('file-chip')[0]!);
    expect(screen.getByTestId('preview-overlay')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('preview-overlay')).toBeNull();
  });

  it('is an always-dark scope — the lightbox ruling, asserted not assumed', () => {
    render(<FilesScreen destinationLabel="T-114" bubble={SPECIMEN_BUBBLE} />);
    fireEvent.click(screen.getAllByTestId('file-chip')[0]!);
    const panel = screen.getByRole('dialog');
    expect(panel.getAttribute('data-theme')).toBe('dark');
    expect(panel.className).toContain('cv2-root');
  });

  it('an image with reachable bytes renders them; without, it refuses honestly', () => {
    const { unmount } = render(
      <FilesScreen
        destinationLabel="T"
        attached={SPECIMEN_ATTACHED}
        downloadHref={(id) => `/v2/files/${id}/download`}
      />,
    );
    expect(screen.getAllByTestId('preview-image').length).toBeGreaterThan(0);
    unmount();

    render(<FilesScreen destinationLabel="T" attached={SPECIMEN_ATTACHED} />);
    expect(screen.queryAllByTestId('preview-image')).toHaveLength(0);
    expect(screen.getAllByTestId('preview-placeholder').length).toBeGreaterThan(0);
  });

  it('a TEXT preview refuses even WITH a resolver — a URL is not a byte read', () => {
    const row: FileRow = {
      fileEntityId: 'md',
      name: 'layout-spec.md',
      mime: 'text/markdown',
      sizeBytes: 900,
      attributedTo: null,
      attributedAt: null,
      sourceMissing: false,
    };
    render(
      <FilesScreen
        destinationLabel="T"
        attached={[row]}
        downloadHref={(id) => `/v2/files/${id}/download`}
      />,
    );
    const tile = screen.getByTestId('preview-tile');
    expect(within(tile).getByTestId('preview-placeholder')).toBeTruthy();
    expect(within(tile).getByTestId('disabled-with-reason')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// T3-5 — the node room
// ---------------------------------------------------------------------------

describe('T3-5 — the verb sweep', () => {
  it('refuses every unwired act on the machine room', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS)} providers={SPECIMEN_PROVIDERS} />);
    for (const verb of REFUSED_VERBS_NODE) assertRefused(verb);
  });

  it('Restore is refused AND its consent dialog is never offered', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS)} />);
    assertRefused('Restore…');
    // A destructive typed-confirmation that leads nowhere is worse than no
    // button; the screen says why instead of staging a dialog.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/It is not offered here/)).toBeTruthy();
  });
});

describe('T3-5 — the no-invented-number sweep', () => {
  it('a cold node room contains NO digit anywhere', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS_COLD)} />);
    // The strongest form of the dash-not-zero law: with nothing measured,
    // there is nothing numeric to show. "8 slots", "up 14d 6h", "412 MB" and
    // a bare "0" all fail this line.
    expect(dataSurfaceText(screen.getByTestId('node-room'))).not.toMatch(/\d/);
  });

  it('renders dashes, not zeros, for every unmeasured fact', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS_COLD)} />);
    const hollow = screen.getAllByTestId('hollow-inline');
    expect(hollow.length).toBeGreaterThanOrEqual(8);
    for (const el of hollow) {
      expect(el.textContent).toContain('—');
      // Every dash carries WHY it is a dash — a bare em dash is just as
      // uninformative as a fabricated number.
      expect(el.getAttribute('title')!.length).toBeGreaterThan(10);
    }
  });

  it('the database and backup rows are DRAWN, not hidden', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS_COLD)} />);
    // "Unavailable ≠ invisible": a user who cannot see that backups exist
    // cannot ask why they are missing.
    expect(screen.getAllByTestId('subsystem-row')).toHaveLength(3);
    const grid = screen.getByTestId('data-grid');
    for (const key of ['database', 'files store', 'last backup', 'schedule']) {
      expect(within(grid).getByText(key)).toBeTruthy();
    }
  });
});

describe('T3-5 — the two facts that ARE measured', () => {
  it('a live connection renders healthy, from the seam’s verdict alone', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS)} />);
    const server = subsystem('server');
    expect(within(server).getByText('healthy')).toBeTruthy();
  });

  it('a polling connection renders DEGRADED and names cause AND consequence', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS_DEGRADED)} />);
    const server = subsystem('server');
    expect(within(server).getByText('degraded')).toBeTruthy();
    const facts = server.textContent ?? '';
    expect(facts).toContain('websocket down since');
    expect(facts).toContain('data advances slower');
  });

  it('the header pill never disagrees with the row — one source, two places', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS_DEGRADED)} />);
    const card = screen.getByTestId('node-status-card');
    const head = card.querySelector('.fn-card__head')!;
    const server = subsystem('server');
    // The exact defect this prevents is the gate-evidence artifact: "1 live"
    // above a row saying "not running".
    expect(head.textContent).toContain('degraded');
    expect(server.textContent).toContain('degraded');
  });

  it('live sessions are a REAL count and a real zero prints as 0', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS)} />);
    expect(subsystem('agent host').textContent).toContain('3 sessions live');

    cleanup();
    render(
      <NodeRoom port={staticNodePort({ ...SPECIMEN_NODE_FACTS, liveSessionCount: 0 })} />,
    );
    // Measured zero ⇒ "0", not a dash. The type carries the distinction.
    expect(subsystem('agent host').textContent).toContain('0 sessions live');
  });
});

describe('T3-5 — concurrency, and the cap that cannot be known', () => {
  it('draws one pill per live session and NO hollow pills', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS)} />);
    const strip = screen.getByTestId('concurrency-pills');
    expect(strip.querySelectorAll('.fn-conc__pill--used')).toHaveLength(3);
    // A hollow pill is a claim about how many slots exist. The oracle draws
    // five of them; this build cannot know the number, so it draws none and
    // says so in words instead.
    expect(strip.querySelectorAll('.fn-conc__pill:not(.fn-conc__pill--used)')).toHaveLength(0);
    expect(within(strip).getByText(/remaining slots unknown/)).toBeTruthy();
  });

  it('states the cap as unknown rather than transcribing the canvas’s 8', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS)} />);
    const conc = screen.getByTestId('concurrency');
    expect(conc.textContent).not.toContain('8 slots');
    expect(conc.textContent).toContain('3 in use');
    expect(within(conc).getAllByTestId('hollow-inline').length).toBeGreaterThan(0);
  });
});

describe('T3-5 — providers', () => {
  it('invents no providers when none are supplied', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS)} />);
    expect(screen.queryAllByTestId('provider-row')).toHaveLength(0);
    expect(screen.getByTestId('providers-empty').textContent).toContain(
      'No provider registry is readable',
    );
    // Specifically: the canvas's two names must not leak in from anywhere.
    const room = screen.getByTestId('node-room').textContent ?? '';
    expect(room).not.toContain('claude');
    expect(room).not.toContain('codex');
  });

  it('shows a host-supplied probe result whole — real exit code and stderr', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS)} providers={SPECIMEN_PROVIDERS} />);
    const rows = screen.getAllByTestId('provider-row');
    expect(rows).toHaveLength(2);
    // "test launch shows real exit + stderr, not 'something went wrong'" (L215).
    expect(rows[1]!.textContent).toContain('exit 127');
    expect(rows[1]!.textContent).toContain('command not found');
  });

  it('a never-probed provider says so instead of claiming ok', () => {
    render(
      <NodeRoom
        port={staticNodePort(SPECIMEN_NODE_FACTS)}
        providers={[{ name: 'p', command: 'x {workdir}' }]}
      />,
    );
    const row = screen.getByTestId('provider-row');
    expect(within(row).getByTestId('hollow-inline').textContent).toContain('never probed');
    expect(row.textContent).not.toContain('ok');
  });

  it('keeps the template variables intact (L202)', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS)} providers={SPECIMEN_PROVIDERS} />);
    expect(screen.getByText(/--session-dir \{workdir\} --profile \{profile\}/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

describe('the surface as a whole', () => {
  it('the node room is graphite in BOTH themes (oracle L237)', () => {
    render(<NodeRoom port={staticNodePort(SPECIMEN_NODE_FACTS)} />);
    const room = screen.getByTestId('node-room');
    expect(room.getAttribute('data-theme')).toBe('dark');
    expect(room.getAttribute('data-always-dark')).toBe('true');
    expect(room.className).toContain('cv2-root');
  });

  it('the port subscribes on mount and refreshes exactly once', () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const refresh = vi.fn(async () => {});
    const port = { facts: () => SPECIMEN_NODE_FACTS_COLD, subscribe, refresh };
    const { unmount } = render(<NodeRoom port={port} />);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    // The gap between "subscribed" and "unsubscribed" is where leaks live.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('re-renders when the port pushes new facts', () => {
    let push: ((f: typeof SPECIMEN_NODE_FACTS) => void) | null = null;
    let current = SPECIMEN_NODE_FACTS_COLD;
    const port = {
      facts: () => current,
      subscribe: (cb: (f: typeof SPECIMEN_NODE_FACTS) => void) => {
        push = cb;
        return () => {};
      },
      refresh: async () => {},
    };
    render(<NodeRoom port={port} />);
    expect(dataSurfaceText(screen.getByTestId('node-room'))).not.toMatch(/\d/);
    current = SPECIMEN_NODE_FACTS;
    // The four-links lesson: a subscription that is never DELIVERED to is a
    // green declaration over a dead feature. Assert the delivery, through
    // act() so React flushes the update the way a real event loop would.
    act(() => {
      (push as unknown as (f: typeof SPECIMEN_NODE_FACTS) => void)(SPECIMEN_NODE_FACTS);
    });
    expect(subsystem('agent host').textContent).toContain('3 sessions live');
  });

  it('the gap ledger is non-empty, well-formed, and splits by remedy', () => {
    expect(ALL_FILES_NODE_REASONS.length).toBeGreaterThanOrEqual(14);
    for (const reason of ALL_FILES_NODE_REASONS) {
      expect(reason.cause.length).toBeGreaterThan(10);
      expect(reason.remedy!.length).toBeGreaterThan(20);
    }
    // The two remedies are genuinely different work; collapsing them would
    // hide that most of the node room needs a SERVER, not a seam amendment.
    expect(MISSING_FILE_OPS.some((o) => o.kind === 'seam-gap')).toBe(true);
    expect(MISSING_FILE_OPS.some((o) => o.kind === 'capability')).toBe(true);
  });

  it('the product defaults are EMPTY — no specimen leaks into a real mount', () => {
    render(<FilesScreen destinationLabel="this task" />);
    const text = screen.getByTestId('files-screen').textContent ?? '';
    for (const leak of ['rail-collapsed', 'layout-spec-v3', 'session-recording', '@ada']) {
      expect(text).not.toContain(leak);
    }
  });

  it('annotations are OFF by default and ON when asked (the oracle’s own sc-if)', () => {
    const { unmount } = render(<FilesScreen destinationLabel="T" />);
    expect(screen.queryByTestId('files-legend')).toBeNull();
    unmount();
    render(<FilesScreen destinationLabel="T" notes />);
    expect(screen.getByTestId('files-legend')).toBeTruthy();
  });
});
