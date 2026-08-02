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

  it('thumbnails an image and chips everything else', () => {
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
    // The size guard, asserted on the element so it survives a missing sheet.
    expect(img.style.maxWidth).toBe('100%');
    expect(img.style.maxHeight).toBe('160px');

    expect(screen.getByText('spec.pdf')).toBeTruthy();
    expect(screen.getByText('2K')).toBeTruthy();
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
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        files={[row({ fileEntityId: 'f1', name: 'notes.txt', mime: 'text/plain' })]}
      />,
    );
    expect(document.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByText('no download here')).toBeTruthy();
  });

  it('links a downloadable file with its own name', () => {
    render(
      <AttachmentStrip
        anchorId={'e1' as never}
        downloadHref={href}
        files={[row({ fileEntityId: 'f1', name: 'notes.txt', mime: 'text/plain' })]}
      />,
    );
    const link = document.querySelector('a') as HTMLAnchorElement;
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
