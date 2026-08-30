// @vitest-environment jsdom
/**
 * THE ATTACHMENT STRIP, driven end to end.
 *
 * Same law as `port-seam.test.tsx`: the upload half runs against a REAL
 * `createFixtureSeam()` through the REAL `attachmentsPortFromSeam`, so a green
 * run means bytes went through the actual grant lifecycle — not that a spy saw
 * a call. The four-links lesson applies exactly here: declaration, data,
 * implementation and CALL were all green for `files.download` for weeks while
 * nothing on screen could reach it.
 *
 * The SVG assertion is the one nobody would think to write and the one that
 * matters most: the server refuses to serve `image/svg+xml` inline
 * (files.ts:128-145) because an SVG is a script-bearing document. An `<img>`
 * pointed at that route asks for exactly the response the server declines to
 * give, so this suite pins "SVG is a chip" as a rule rather than a preference.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AttachmentStrip, canThumbnail } from './AttachmentStrip';
import { attachmentsPortFromSeam } from './port';
import { createFixtureSeam } from '../data';
import type { FileRow } from './model';

function row(over: Partial<FileRow> & Pick<FileRow, 'fileEntityId' | 'name' | 'mime'>): FileRow {
  return {
    sizeBytes: 2048,
    attributedTo: { id: 'actor-ada', displayName: 'ada', isAgent: false, avatar: null },
    attributedAt: '2026-08-01T00:00:00.000Z',
    sourceMissing: false,
    // Null by default on purpose: most rows in this suite are testing the READ
    // half, and a row that was not reached through an edge must not sprout a
    // Remove button. The detach suite opts in explicitly.
    edgeId: null,
    ...over,
  };
}

const href = (id: string) => `/v2/files/${id}/download`;

describe('the strip renders what is attached, and nothing when nothing is', () => {
  it('renders NOTHING at all with no files and no uploader — not an empty box', () => {
    const { container } = render(<AttachmentStrip anchorId={'e1' as never} files={[]} />);
    // The designed empty. A bordered "Attachments · 0" under every entity in
    // the workspace would be chrome claiming a feature that is not wired.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('attachment-strip')).toBeNull();
  });

  it('renders the dropzone as its own empty state when an uploader IS present', () => {
    render(
      <AttachmentStrip anchorId={'e1' as never} files={[]} startUpload={() => { throw new Error('unused'); }} />,
    );
    expect(screen.getByTestId('attachment-strip')).toBeTruthy();
    expect(screen.getByTestId('attachment-file-input')).toBeTruthy();
    // No file rows invented to fill the space.
    expect(screen.queryAllByTestId('attachment-item')).toHaveLength(0);
  });

  it('thumbnails an image tile and gives everything else the glyph face', () => {
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        downloadHref={href}
        files={[
          row({ fileEntityId: 'f-png', name: 'shot.png', mime: 'image/png' }),
          row({ fileEntityId: 'f-pdf', name: 'spec.pdf', mime: 'application/pdf' }),
        ]}
      />,
    );
    const items = screen.getAllByTestId('attachment-item');
    expect(items).toHaveLength(2);
    expect(items[0]!.getAttribute('data-thumb')).toBe('true');
    expect(items[1]!.getAttribute('data-thumb')).toBe('false');

    const img = screen.getByAltText('shot.png') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/v2/files/f-png/download');
    // The size guard, asserted on the element so it survives a missing sheet:
    // a 5000px photo fills the uniform tile instead of blowing it out.
    expect(img.style.width).toBe('100%');
    expect(img.style.height).toBe('100%');
    expect(img.style.objectFit).toBe('cover');

    // The non-image tile: name below, full `name · size` on the tile itself.
    expect(screen.getByText('spec.pdf')).toBeTruthy();
    expect(items[1]!.getAttribute('title')).toBe('spec.pdf · 2K');
  });

  it('NEVER renders an <img> for image/svg+xml — the server refuses it inline', () => {
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        downloadHref={href}
        files={[row({ fileEntityId: 'f-svg', name: 'logo.svg', mime: 'image/svg+xml' })]}
      />,
    );
    expect(screen.getByTestId('attachment-item').getAttribute('data-thumb')).toBe('false');
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText('logo.svg')).toBeTruthy();

    // And the predicate itself, so the rule is pinned away from the DOM too.
    expect(canThumbnail('image/svg+xml')).toBe(false);
    expect(canThumbnail('IMAGE/SVG+XML')).toBe(false);
    expect(canThumbnail('image/png')).toBe(true);
    expect(canThumbnail('application/pdf')).toBe(false);
  });

  it('says so rather than linking nowhere when no href resolver is supplied', () => {
    // Download lives in the lightbox now — open before asserting.
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        files={[row({ fileEntityId: 'f1', name: 'notes.txt', mime: 'text/plain' })]}
      />,
    );
    fireEvent.click(screen.getByTestId('attachment-item'));
    expect(document.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByText('no download here')).toBeTruthy();
  });

  it('links a downloadable file with its own name — inside the lightbox', () => {
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        downloadHref={href}
        files={[row({ fileEntityId: 'f1', name: 'notes.txt', mime: 'text/plain' })]}
      />,
    );
    fireEvent.click(screen.getByTestId('attachment-item'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const link = dialog.querySelector('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/v2/files/f1/download');
    expect(link.getAttribute('download')).toBe('notes.txt');
  });
});

describe('uploading through the REAL seam lifecycle', () => {
  it('runs init → putBytes → complete and reports the finished file', async () => {
    const seam = createFixtureSeam();
    const spaces = await seam.spaces();
    const spaceId = spaces[0]!.id;
    // An anchor the fixture actually knows: `complete` validates its targets.
    const anchor = (await seam.query({ spaceId })).page.items[0]!;

    const port = attachmentsPortFromSeam(seam, spaceId);
    const onUploaded = vi.fn();

    render(
      <AttachmentStrip
        anchorId={anchor.id}
        files={[]}
        downloadHref={port.downloadHref}
        startUpload={port.startUpload}
        onUploaded={onUploaded}
      />,
    );

    const input = screen.getByTestId('attachment-file-input') as HTMLInputElement;
    const file = new File(['hello attachments'], 'hello.txt', { type: 'text/plain' });
    // jsdom's FileList is read-only; defining the property is the standard way.
    fireEvent.change(input, { target: { files: [file] } });

    // THE assertion: the whole grant lifecycle actually completed against the
    // seam. A spy on `uploadInit` would have passed while `complete` 500'd.
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('attachment-pending')).toBeNull();
  });

  it('the download href the port hands out is the contract-v1 route', async () => {
    const seam = createFixtureSeam();
    const spaces = await seam.spaces();
    const port = attachmentsPortFromSeam(seam, spaces[0]!.id);
    // `/download`, NOT `/content` — the latter 404s (catalog.ts:118).
    expect(port.downloadHref('file-42')).toBe('/v2/files/file-42/download');
  });
});

// ---------------------------------------------------------------------------
// DETACH — the door that only opened one way until now
// ---------------------------------------------------------------------------

describe('removing an attachment cuts the LINK, not the file', () => {
  it('offers Remove only for a row that was reached through an edge', () => {
    // Remove lives in the lightbox now (which is why tiles carry no hover ×):
    // open each tile's lightbox before asserting — open, never delete.
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        downloadHref={href}
        onDetach={async () => {}}
        files={[
          row({ fileEntityId: 'f-linked', name: 'linked.txt', mime: 'text/plain', edgeId: 'edge-1' }),
          // Reached from a message or the gallery: there IS no link to cut, so
          // offering to cut one would be a button with nothing behind it.
          row({ fileEntityId: 'f-loose', name: 'loose.txt', mime: 'text/plain' }),
        ]}
      />,
    );
    const items = screen.getAllByTestId('attachment-item');
    fireEvent.click(items[0]!);
    expect(screen.getAllByTestId('attachment-detach')).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(items[1]!);
    expect(screen.queryByTestId('attachment-detach')).toBeNull();
  });

  it('draws NO Remove at all when the host wired no detach', () => {
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        downloadHref={href}
        files={[row({ fileEntityId: 'f1', name: 'a.txt', mime: 'text/plain', edgeId: 'edge-1' })]}
      />,
    );
    // Same law as the dropzone: a Remove that cannot remove is worse than no
    // Remove, because the user believes the file went away.
    expect(screen.queryByTestId('attachment-detach')).toBeNull();
  });

  it('passes the EDGE id — not the file id — and tells the host to refetch', async () => {
    const onDetach = vi.fn().mockResolvedValue(undefined);
    const onDetached = vi.fn();
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        downloadHref={href}
        onDetach={onDetach}
        onDetached={onDetached}
        files={[row({ fileEntityId: 'f-9', name: 'a.txt', mime: 'text/plain', edgeId: 'edge-9' })]}
      />,
    );
    fireEvent.click(screen.getByTestId('attachment-item'));
    fireEvent.click(screen.getByTestId('attachment-detach'));
    // The file id would delete SOME OTHER edge, or nothing, and read as a dead
    // button either way.
    expect(onDetach).toHaveBeenCalledWith('edge-9');
    await waitFor(() => expect(onDetached).toHaveBeenCalledTimes(1));
    // Success closes the lightbox — the act completed, nothing to keep open.
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('states a refusal in the OPEN lightbox instead of leaving a dead button', async () => {
    const onDetach = vi.fn().mockRejectedValue(Object.assign(new Error('no'), { code: 'forbidden' }));
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        downloadHref={href}
        onDetach={onDetach}
        files={[row({ fileEntityId: 'f-9', name: 'a.txt', mime: 'text/plain', edgeId: 'edge-9' })]}
      />,
    );
    fireEvent.click(screen.getByTestId('attachment-item'));
    fireEvent.click(screen.getByTestId('attachment-detach'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('do not have permission');
    // Failure keeps the lightbox OPEN, and the tile stays: nothing was
    // removed, so nothing may disappear.
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByText('a.txt').length).toBeGreaterThan(0);
  });

  it('deletes the edge from BOTH endpoints through the REAL seam', async () => {
    const seam = createFixtureSeam();
    const spaces = await seam.spaces();
    const spaceId = spaces[0]!.id;
    const port = attachmentsPortFromSeam(seam, spaceId);

    // Any real fixture edge will do: what is under test is that a detach
    // removes the link from the peer's panel too. A one-sided delete leaves
    // the file still listed on the other entity — a split brain a real DELETE
    // cannot produce, so the fixture must not produce one either.
    const items = (await seam.query({ spaceId })).page.items;
    let subject: { id: string; edgeId: string; peerId: string } | null = null;
    for (const item of items) {
      const detail = await seam.entity(item.id);
      const group = [...detail.connections.outgoing, ...detail.connections.incoming]
        .find((g) => g.edges.length > 0);
      const edge = group?.edges[0];
      if (!edge) continue;
      const peerId = edge.source.id === item.id ? edge.target.id : edge.source.id;
      subject = { id: item.id, edgeId: edge.id, peerId };
      break;
    }
    if (subject === null) throw new Error('fixture has no edges — this test would prove nothing');

    await port.detach(subject.edgeId);

    for (const id of [subject.id, subject.peerId]) {
      const after = await seam.entity(id as never);
      const ids = [...after.connections.outgoing, ...after.connections.incoming]
        .flatMap((g) => g.edges.map((e) => e.id));
      expect(ids).not.toContain(subject.edgeId);
    }
  });

  it('refuses an edge that is not there rather than reporting a phantom success', async () => {
    const seam = createFixtureSeam();
    const spaces = await seam.spaces();
    const port = attachmentsPortFromSeam(seam, spaces[0]!.id);
    await expect(port.detach('edge-that-never-was')).rejects.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// THE ＋ TILE AND THE LIGHTBOX — the 2026-08-16 addendum's own contracts
// ---------------------------------------------------------------------------

describe('the + tile', () => {
  it('is an ICON on an empty anchor — one 28px paperclip, not a dashed tile and not nothing', () => {
    // Owner ruling 2026-08-19, narrowing 2026-08-18. The addendum's "the ＋
    // tile IS the empty state" cost ~140px of dashed box on every entity that
    // never had a file, so it went; but what replaced it was DROP ALONE, and a
    // touch screen has no drag — the report that reopened this was "attach
    // option not visible in entity detail screen". The tile stays gone, its
    // affordance comes back as an icon. The ROOT still survives idle for the
    // drop listeners (`rootRef.current.closest(...)`).
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        files={[]}
        projectFolder={{ projects: vi.fn(), list: vi.fn(), attach: vi.fn() } as never}
      />,
    );
    const add = screen.getByTestId('attachment-add');
    // Named for assistive tech, wordless on screen — no 'attach' label row,
    // which is what made the tile tall.
    expect(add.getAttribute('aria-label')).toBe('Attach a file');
    expect(add.textContent).toBe('📎');
    expect(add.className).toContain('fn-tile--clip');
    expect(add.className).not.toContain('fn-tile--plus');
    expect(screen.queryByText(/no attachments/i)).toBeNull();
    const root = screen.getByTestId('attachment-strip');
    expect(root.dataset.idle).toBe('true');
    expect(root.className).toContain('fn-tiles--idle');
  });

  it('taps straight through to the one wired path while idle — no menu in the way', async () => {
    const projects = vi.fn().mockResolvedValue([]);
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        files={[]}
        projectFolder={{ projects, list: vi.fn(), attach: vi.fn() } as never}
      />,
    );
    fireEvent.click(screen.getByTestId('attachment-add'));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  });

  it('opens the device picker from the idle icon — the mobile path', () => {
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        files={[]}
        startUpload={() => { throw new Error('unused'); }}
      />,
    );
    const input = screen.getByTestId('attachment-file-input') as HTMLInputElement;
    // No `accept`, no `capture`: the phone's own sheet then offers camera,
    // photo library and files, and narrowing it here removes the user's
    // choices.
    expect(input.getAttribute('accept')).toBeNull();
    expect(input.getAttribute('capture')).toBeNull();
    const clicked = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTestId('attachment-add'));
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('becomes the labelled tile once the anchor has a file — the tile grammar its neighbours use', () => {
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        files={[row({ fileEntityId: 'f1', name: 'notes.txt', mime: 'text/plain' })]}
        startUpload={() => { throw new Error('unused'); }}
      />,
    );
    const add = screen.getByTestId('attachment-add');
    expect(add.className).toContain('fn-tile--plus');
    expect(add.textContent).toContain('attach');
  });

  it('comes back the moment the anchor has a file, and acts directly with one wired path', async () => {
    const projects = vi.fn().mockResolvedValue([]);
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        files={[row({ fileEntityId: 'f1', name: 'notes.txt', mime: 'text/plain' })]}
        projectFolder={{ projects, list: vi.fn(), attach: vi.fn() } as never}
      />,
    );
    expect(screen.getByTestId('attachment-strip').dataset.idle).toBeUndefined();
    // One wired path ⇒ no menu, straight to the picker: a one-item menu is a
    // click tax.
    fireEvent.click(screen.getByTestId('attachment-add'));
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
  });

  it('opens the two-item menu when both paths are wired, and Esc returns focus to +', () => {
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        /* One file, because the ＋ is gated on a non-idle strip now. */
        files={[row({ fileEntityId: 'f1', name: 'notes.txt', mime: 'text/plain' })]}
        startUpload={() => { throw new Error('unused'); }}
        projectFolder={{ projects: vi.fn(), list: vi.fn(), attach: vi.fn() } as never}
      />,
    );
    const plus = screen.getByTestId('attachment-add');
    fireEvent.click(plus);
    expect(screen.getAllByRole('menuitem')).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(plus);
  });
});

describe('the lightbox', () => {
  it('opens from a tile, closes on Esc, and returns focus to the originating tile', () => {
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        downloadHref={href}
        files={[row({ fileEntityId: 'f1', name: 'notes.txt', mime: 'text/plain' })]}
      />,
    );
    const tile = screen.getByTestId('attachment-item');
    fireEvent.click(tile);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps Remove in the tab order while a detach is in flight — busy, never disabled', async () => {
    // A natively disabled control leaves the tab order mid-trap and the next
    // Tab walks out of an aria-modal dialog. Busy instead: focusable, guarded.
    let resolveDetach: () => void = () => {};
    const onDetach = vi.fn(() => new Promise<void>((resolve) => { resolveDetach = resolve; }));
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        downloadHref={href}
        onDetach={onDetach}
        files={[row({ fileEntityId: 'f1', name: 'a.txt', mime: 'text/plain', edgeId: 'edge-1' })]}
      />,
    );
    fireEvent.click(screen.getByTestId('attachment-item'));
    const remove = screen.getByTestId('attachment-detach');
    fireEvent.click(remove);
    expect(remove.hasAttribute('disabled')).toBe(false);
    expect(remove.getAttribute('aria-busy')).toBe('true');
    // The guard, not the disabled attribute, is what stops a second fire.
    fireEvent.click(remove);
    expect(onDetach).toHaveBeenCalledTimes(1);
    resolveDetach();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('renders file info — never an <img> — for SVG, in the large frame as in the tile', () => {
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        downloadHref={href}
        files={[row({ fileEntityId: 'f-svg', name: 'logo.svg', mime: 'image/svg+xml' })]}
      />,
    );
    fireEvent.click(screen.getByTestId('attachment-item'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelectorAll('img')).toHaveLength(0);
    expect(dialog.textContent).toContain('image/svg+xml');
    // The bytes are still reachable the honest way: a download link, not an
    // inline render.
    expect(dialog.querySelector('a')?.getAttribute('download')).toBe('logo.svg');
  });
});
