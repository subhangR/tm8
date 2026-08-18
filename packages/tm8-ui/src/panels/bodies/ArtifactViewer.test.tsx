// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { ArtifactPreviewSession, ArtifactsPreviewStartInput } from '@tm8/contract';
import type { ArtifactRevisionsList, Seam } from '../../data/seam';
import { createFixtureSeam } from '../../data/fixtures/seam-fixture';
import { getKind } from '../../domain';
import { artifactPulseBoard, fixtureDetails } from '../../fixtures';
import { GenericBody, type ArtifactPreviewCommands } from './GenericBody';

/**
 * THE ARTIFACT RENDER FLOW — first tests ever (Artifacts Phase 2).
 *
 * What these assertions pin, in order of what it costs to lose them:
 *
 *   1. THE SANDBOX IS EXACT. `sandbox="allow-scripts"` — EXACT string
 *      equality, never a substring match. `allow-scripts allow-same-origin`
 *      CONTAINS the right token and lets the frame strip its own sandbox;
 *      a toContain assertion would wave it through. This one line is the
 *      regression guard for the entire artifact security model.
 *   2. AUTORUN IS REAL. The iframe exists without any click (owner ruling
 *      2026-08-16). A Run-gate regression renders metadata and waits.
 *   3. THE TTL IS HANDLED. The capability lapses at ~600s; the block must
 *      re-mint BEFORE that and swap the src, or a panel left open shows a
 *      silently dead frame that still looks rendered.
 *   4. REFUSALS ARE HONEST AND FRAMELESS. No previewUrl → words, zero
 *      iframes. No command executor → words, zero iframes. A broken frame
 *      reads as a product bug; a fabricated URL would be worse.
 *   5. THE CHROME IS PRESENT. Publisher identity + third-party wording are
 *      the phishing countermeasure for the accepted §12.1 residual — a
 *      security control, so their absence is a failure, not a style choice.
 *
 * jsdom loads NO stylesheets: nothing here asserts colour, layout or zoom —
 * attributes, DOM structure and calls only.
 */

/**
 * Unit-7 evidence (GraphScreen wiring): every detail host passes
 * `seam.commands` verbatim, and this type-level check proves that object
 * structurally satisfies the viewer's port — so the block receives a LIVE
 * `previewArtifact` under the graph host too (GraphScreen.tsx passes
 * `commands={data.seam?.commands}`). There is no GraphScreen render harness
 * to extend cheaply; if the seam ever drops a member, this stops compiling.
 */
type SeamCommandsCarryViewerPort = Seam['commands'] extends ArtifactPreviewCommands ? true : never;
const seamCommandsCarryViewerPort: SeamCommandsCarryViewerPort = true;
void seamCommandsCarryViewerPort;

const DETAIL = fixtureDetails[artifactPulseBoard.id]!;
const BLOCKS = getKind('artifact').panel?.blocks ?? [];

function session(over: Partial<ArtifactPreviewSession> = {}): ArtifactPreviewSession {
  return {
    previewSessionId: 'ps-1',
    token: 'tok-1',
    revisionNumber: 3,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    previewUrl: 'https://node.example/preview/cap-1',
    ...over,
  };
}

function revisionRows(): ArtifactRevisionsList {
  return {
    revisions: [3, 2, 1].map((n) => ({
      revisionNumber: n,
      manifestSha256: 'a'.repeat(64),
      entrypoint: 'index.html',
      fileCount: 1,
      totalSizeBytes: 1024 * n,
      sourceProvenance: null,
      createdAt: `2026-07-2${5 + n}T12:00:00.000Z`,
      publishedBy: 'act-forge',
    })),
  };
}

function renderViewer(commands?: Partial<ArtifactPreviewCommands>) {
  return render(<GenericBody detail={DETAIL} blocks={BLOCKS} commands={commands} />);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('artifact viewer — auto-render and the sandbox', () => {
  it('registry sanity: the artifact kind declares the preview block', () => {
    expect(BLOCKS.map((b) => b.block)).toContain('artifact-preview');
  });

  it('opening an artifact detail renders the iframe with NO click', async () => {
    const previewArtifact = vi.fn(async () => session());
    const { container } = renderViewer({ previewArtifact });
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(previewArtifact).toHaveBeenCalledTimes(1);
    const iframe = container.querySelector('iframe')!;
    // The URL is opaque: used verbatim, never rebuilt.
    expect(iframe.getAttribute('src')).toBe('https://node.example/preview/cap-1');
  });

  it('THE ONE ASSERTION: sandbox is exactly allow-scripts', async () => {
    const previewArtifact = vi.fn(async () => session());
    const { container } = renderViewer({ previewArtifact });
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    // EXACT equality. `toContain('allow-scripts')` would pass a frame that
    // also grants allow-same-origin — the one token that unmakes the sandbox.
    expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts');
  });
});

describe('artifact viewer — TTL re-mint', () => {
  it('re-mints before expiresAt, swaps the src, and PINS the minted revision', async () => {
    vi.useFakeTimers();
    let mints = 0;
    const previewArtifact = vi.fn(async () => {
      mints += 1;
      return session({
        previewUrl: `https://node.example/preview/cap-${mints}`,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      });
    });
    const { container } = renderViewer({ previewArtifact });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe('https://node.example/preview/cap-1');
    // The FIRST latest-revision mint names no revision — the server resolves
    // "current" exactly once.
    expect(previewArtifact.mock.calls[0]![1]).not.toHaveProperty('revisionNumber');
    // 120s TTL − 60s margin ⇒ the re-mint fires at 60s; step past it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(previewArtifact).toHaveBeenCalledTimes(2);
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe('https://node.example/preview/cap-2');
    // THE PIN (review F1): the re-mint names the revision the first answer
    // carried, so a concurrent publish can never silently swap the page
    // under the viewer — tracking latest stays an explicit act.
    expect(previewArtifact.mock.calls[1]![1]).toMatchObject({ revisionNumber: 3 });
  });
});

describe('artifact viewer — honest refusals, zero iframes', () => {
  it('a session without previewUrl renders the refusal text and no frame', async () => {
    const previewArtifact = vi.fn(async () => session({ previewUrl: undefined }));
    const { container, findByText } = renderViewer({ previewArtifact });
    await findByText(/did not mint a preview URL/);
    expect(container.querySelectorAll('iframe').length).toBe(0);
  });

  it('a mount with no command executor says so and executes nothing', () => {
    const { container, getByText } = renderViewer(undefined);
    getByText(/Preview is not wired here/);
    expect(container.querySelectorAll('iframe').length).toBe(0);
  });
});

describe('artifact viewer — revisions, download, chrome, fullscreen', () => {
  it('lists revisions, marks the current one, and re-mints the selected one', async () => {
    const listArtifactRevisions = vi.fn(async () => revisionRows());
    const previewArtifact = vi.fn(async (_id: string, input: ArtifactsPreviewStartInput) =>
      session({ revisionNumber: input.revisionNumber ?? 3 }),
    );
    const { findByLabelText, getByText } = renderViewer({ previewArtifact, listArtifactRevisions });
    const select = await findByLabelText('revision');
    expect(listArtifactRevisions).toHaveBeenCalledWith(DETAIL.id);
    getByText('rev 3 · current');
    fireEvent.change(select, { target: { value: '2' } });
    await waitFor(() => {
      expect(previewArtifact).toHaveBeenLastCalledWith(
        DETAIL.id,
        expect.objectContaining({ revisionNumber: 2 }),
      );
    });
  });

  it('download drives the export seam: raw bytes → object URL → revoke', async () => {
    const zip = new Blob(['PK'], { type: 'application/zip' });
    const exportArtifactRevision = vi.fn(async () => zip);
    const previewArtifact = vi.fn(async () => session());
    const createObjectURL = vi.fn(() => 'blob:tm8/zip-1');
    const revokeObjectURL = vi.fn();
    // jsdom has neither; install and remove so no other test inherits them.
    (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL;
    try {
      const { findByText } = renderViewer({ previewArtifact, exportArtifactRevision });
      fireEvent.click(await findByText('Download ⇩'));
      await waitFor(() => expect(exportArtifactRevision).toHaveBeenCalledWith(DETAIL.id, 3));
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:tm8/zip-1');
    } finally {
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    }
  });

  it('download fetches the SHOWN (mint-time) revision, not the detail-time one', async () => {
    // The node answers revision 4 while the stale detail state still says 3 —
    // the review F1 scenario. Download must follow the frame, not the record.
    const zip = new Blob(['PK'], { type: 'application/zip' });
    const exportArtifactRevision = vi.fn(async () => zip);
    const previewArtifact = vi.fn(async () => session({ revisionNumber: 4 }));
    const createObjectURL = vi.fn(() => 'blob:tm8/zip-2');
    const revokeObjectURL = vi.fn();
    (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL;
    try {
      const { container, findByText } = renderViewer({ previewArtifact, exportArtifactRevision });
      await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
      fireEvent.click(await findByText('Download ⇩'));
      await waitFor(() => expect(exportArtifactRevision).toHaveBeenCalledWith(DETAIL.id, 4));
    } finally {
      delete (URL as unknown as Record<string, unknown>).createObjectURL;
      delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    }
  });

  it('names the publisher and disowns the content ON THE FRAME ITSELF', async () => {
    // The publisher line + third-party wording are the phishing countermeasure
    // (§12.1 residual). They used to be a banner above the frame; the owner
    // ruled that banner out on 2026-08-18 for the ~200px it cost, so they now
    // ride the frame's accessible name — the element that actually runs the
    // third-party code, which is a strictly closer place to hang them.
    const previewArtifact = vi.fn(async () => session());
    const { container } = renderViewer({ previewArtifact });
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const title = container.querySelector('iframe')!.getAttribute('title') ?? '';
    expect(title).toContain('published by forge (agent)');
    expect(title).toContain('revision 3');
    expect(title).toContain('not tm8 UI');
    expect(title).toContain('never enter tm8 credentials');
  });

  it('NO phase draws the old banner — the viewer opens on its controls', async () => {
    // The counterpart to the assertion above: the sentence is on the frame, so
    // it must not have quietly survived as visible text anywhere. A phase with
    // no frame carries no residual to compensate for — there is nothing
    // executing — and it, too, must not reintroduce the band.
    const bannerAbsent = (container: HTMLElement) => {
      const text = container.textContent ?? '';
      expect(text).not.toContain('published by');
      expect(text).not.toContain('Third-party content');
      expect(container.querySelector('.pn-preview__who')).toBeNull();
    };
    // not-wired: no command executor at all.
    bannerAbsent(renderViewer(undefined).container);
    cleanup();
    // starting: the mint never settles inside this test.
    bannerAbsent(renderViewer({ previewArtifact: vi.fn(() => new Promise(() => {})) }).container);
    cleanup();
    // refusal: a session with no previewUrl.
    {
      const { container, findByText } = renderViewer({
        previewArtifact: vi.fn(async () => session({ previewUrl: undefined })),
      });
      await findByText(/did not mint a preview URL/);
      bannerAbsent(container);
      cleanup();
    }
    // error: the mint rejects.
    {
      const { container, findByText } = renderViewer({
        previewArtifact: vi.fn(async () => {
          throw new Error('node fell over');
        }),
      });
      await findByText(/node fell over/);
      bannerAbsent(container);
      // The controls survive every phase even though the banner does not —
      // Restart is how a caller gets out of the error state.
      expect(container.querySelector('.pn-preview__chrome')).not.toBeNull();
    }
  });

  it('the viewer block carries NO eyebrow — nothing sits between the tabs and the frame', () => {
    // The eyebrow is drawn by `ContentBlock` from `block.label`, so the ruling
    // is enforced where the label would come from: registry data. Asserting
    // the absence in the DOM instead would pass for the wrong reason on any
    // mount that renders the block directly, as this suite's own does.
    const viewer = BLOCKS.find((b) => b.block === 'artifact-preview');
    expect(viewer).toBeDefined();
    expect(viewer!.label).toBeUndefined();
  });

  it('fullscreen is a class state on the same element; Escape exits', async () => {
    const previewArtifact = vi.fn(async () => session());
    const { container, findByText } = renderViewer({ previewArtifact });
    const root = () => container.querySelector('.pn-preview')!;
    fireEvent.click(await findByText('Fullscreen ⛶'));
    expect(root().className).toContain('pn-preview--fullscreen');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(root().className).not.toContain('pn-preview--fullscreen');
  });
});

describe('fixture seam — the render path with no server attached', () => {
  it('previewArtifact answers a data: URL, the requested revision, and a TTL', async () => {
    const seam = createFixtureSeam();
    const s1 = await seam.commands.previewArtifact(artifactPulseBoard.id, { clientMutationId: 'cm-1' });
    expect(s1.previewUrl!.startsWith('data:text/html;base64,')).toBe(true);
    expect(s1.revisionNumber).toBe(3);
    expect(Number.isFinite(Date.parse(s1.expiresAt))).toBe(true);
    const s2 = await seam.commands.previewArtifact(artifactPulseBoard.id, {
      clientMutationId: 'cm-2',
      revisionNumber: 1,
    });
    expect(s2.revisionNumber).toBe(1);
    // Different revision, visibly different page — not two identical frames.
    expect(s2.previewUrl).not.toBe(s1.previewUrl);
    expect(atob(s2.previewUrl!.slice('data:text/html;base64,'.length))).toContain('REVISION 1');
  });

  it('listArtifactRevisions answers the full history, newest first', async () => {
    const seam = createFixtureSeam();
    const { revisions } = await seam.commands.listArtifactRevisions(artifactPulseBoard.id);
    expect(revisions.map((r) => r.revisionNumber)).toEqual([3, 2, 1]);
  });

  it('exportArtifactRevision answers REAL zip bytes (PK header), never JSON', async () => {
    const seam = createFixtureSeam();
    const blob = await seam.commands.exportArtifactRevision(artifactPulseBoard.id, 3);
    expect(blob.type).toBe('application/zip');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // 'PK'
  });
});
