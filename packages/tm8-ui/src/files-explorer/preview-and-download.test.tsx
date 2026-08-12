// @vitest-environment jsdom
/**
 * PREVIEW HONESTY AND THE TWO BYTE ROUTES.
 *
 * The bug this file exists for, reported verbatim from the production file
 * browser:
 *
 *   No byte route exists for this entry in this build, so there is nothing
 *   honest to preview.
 *   Download Untitled file
 *
 * Both lines rendered together. The second one is a working link built from
 * the byte route the first one denies having. The screen was image-only and
 * used a no-byte-route message to say "not an image".
 *
 * So the assertions here are about WHICH refusal appears, not merely that one
 * does — a test that only checked "some empty-state is shown" would have
 * passed against the broken build.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesExplorerScreen, importCaption, filterEntries, sortEntries } from './FilesExplorerScreen';
import {
  EXPLORER_REASONS,
  type ExplorerBytes,
  type ExplorerEntry,
  type ExplorerRoot,
  type FilesExplorerPort,
} from './port';
import { rendererFor } from './preview';

afterEach(cleanup);

beforeAll(() => {
  // jsdom implements neither.
  Object.defineProperty(URL, 'createObjectURL', { writable: true, value: vi.fn(() => 'blob:stub') });
  Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: vi.fn() });
});

beforeEach(() => {
  // CLEARED PER TEST, not merely installed once. `clearMocks` is false in this
  // package's vite config, so a `not.toHaveBeenCalled()` assertion over a
  // module-level mock is otherwise order-dependent: it passes only while no
  // earlier test in the file happens to create an object URL, and turns into a
  // false failure the moment one is added above it.
  vi.mocked(URL.createObjectURL).mockClear();
  vi.mocked(URL.revokeObjectURL).mockClear();
});

const libraryRoot: ExplorerRoot = { id: 'library', kind: 'library', label: 'Library', writable: true };
const projectRoot: ExplorerRoot = {
  id: 'project:p1',
  kind: 'project',
  label: 'tm8',
  writable: false,
  projectId: 'p1' as never,
};

function entry(partial: Partial<ExplorerEntry> & { name: string }): ExplorerEntry {
  return {
    path: partial.name,
    type: 'file',
    sizeBytes: 10,
    modifiedAt: '2026-08-10T00:00:00Z',
    mime: 'text/plain',
    entityId: `e:${partial.name}` as never,
    trashed: false,
    version: 1,
    ...partial,
  };
}

function portWith(
  entries: ExplorerEntry[],
  overrides?: Partial<FilesExplorerPort>,
): FilesExplorerPort {
  return {
    roots: async () => [libraryRoot, projectRoot],
    list: async () => ({ entries, truncated: false }),
    downloadHref: (e) => (e.entityId ? `/v2/files/${e.entityId}/download` : null),
    ...overrides,
  };
}

async function openPreview(name: string): Promise<void> {
  const { fireEvent } = await import('@testing-library/react');
  fireEvent.click(await screen.findByLabelText(`Preview ${name}`));
}

describe('the preview says which fact is true', () => {
  it('REGRESSION: a non-image WITH bytes never claims the byte route is missing', async () => {
    // The exact reported shape: a library file that is not an image.
    const xlsx = entry({
      name: 'Maestro_Feature_Tasks.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    // The unrenderable branch PROBES the byte route before claiming anything
    // about the bytes; this stub is what makes the probe succeed.
    const fetchStub = vi.fn(async () => ({ ok: true, status: 206, blob: async () => new Blob() }));
    vi.stubGlobal('fetch', fetchStub);
    render(<FilesExplorerScreen port={portWith([xlsx])} />);
    await openPreview(xlsx.name);

    expect(await screen.findByTestId('fx-preview-no-renderer')).toBeTruthy();
    // One byte, not the whole spreadsheet.
    expect(fetchStub).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: { range: 'bytes=0-0' },
    }));
    expect(screen.queryByText(EXPLORER_REASONS.NO_BYTE_ROUTE)).toBeNull();
    expect(screen.getByText(EXPLORER_REASONS.NO_RENDERER)).toBeTruthy();
    // And the download is still offered, which is what made the old copy absurd.
    const link = screen.getByText(`Download ${xlsx.name}`) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/v2/files/${xlsx.entityId}/download`);
    vi.unstubAllGlobals();
  });

  it('REGRESSION: an entity with an id but no stored bytes offers no download at all', async () => {
    // The phantom the old "Upload file" button made: a `file` entity that was
    // committed without ever uploading. It has an id, so `downloadHref` builds
    // a URL, and `files.download` answers 404 because the row it joins onto
    // does not exist. Three of these are in the production space.
    //
    // This case CANNOT be told from a real upload by looking at the entity:
    // the server returns `content: null` on the summary for file entities, so
    // mime and sizeBytes are null for genuine uploads too (measured against the
    // live node, 2026-08-12). Guessing from those fields would have hidden the
    // download link for the entire library. So the route is asked.
    const phantom = entry({ name: 'Untitled file', mime: null });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, blob: async () => new Blob() })));

    render(<FilesExplorerScreen port={portWith([phantom])} />);
    await openPreview(phantom.name);

    expect(await screen.findByTestId('fx-preview-no-bytes')).toBeTruthy();
    expect(screen.getByText(EXPLORER_REASONS.NO_STORED_BYTES)).toBeTruthy();
    // The whole point: no link that 404s, and no claim that the bytes are fine.
    expect(screen.queryByText(`Download ${phantom.name}`)).toBeNull();
    expect(screen.queryByText(EXPLORER_REASONS.NO_RENDERER)).toBeNull();
    vi.unstubAllGlobals();
  });

  it('says NO BYTE ROUTE only when there is genuinely no route', async () => {
    const orphan = entry({ name: 'ghost.bin', mime: 'application/octet-stream', entityId: null });
    render(<FilesExplorerScreen port={portWith([orphan], { downloadHref: () => null })} />);
    await openPreview(orphan.name);

    expect(await screen.findByTestId('fx-preview-no-route')).toBeTruthy();
    expect(screen.getByText(EXPLORER_REASONS.NO_BYTE_ROUTE)).toBeTruthy();
    // No route means no download link to contradict it.
    expect(screen.queryByText(`Download ${orphan.name}`)).toBeNull();
  });

  it('renders text inline rather than refusing it', async () => {
    const notes = entry({ name: 'notes.md', mime: 'text/markdown' });
    const fetchStub = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(['# hello from the node'], { type: 'text/markdown' }),
    }));
    vi.stubGlobal('fetch', fetchStub);

    render(<FilesExplorerScreen port={portWith([notes])} />);
    await openPreview(notes.name);

    expect(await screen.findByText('# hello from the node')).toBeTruthy();
    // Credentials must ride along or the byte route 401s for a cookie session.
    expect(fetchStub).toHaveBeenCalledWith(expect.any(String), { credentials: 'include' });
    vi.unstubAllGlobals();
  });

  it('surfaces the node’s own refusal instead of a generic failure', async () => {
    const secret = entry({ name: 'app.log', mime: 'text/plain' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, blob: async () => new Blob() })));

    render(<FilesExplorerScreen port={portWith([secret])} />);
    await openPreview(secret.name);

    expect(await screen.findByTestId('fx-preview-failed')).toBeTruthy();
    expect(screen.getByText('You are not allowed to read this file.')).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe('the blob preview path', () => {
  const png = entry({ name: 'shot.png', mime: 'image/png' });
  const pdf = entry({ name: 'spec.pdf', mime: 'application/pdf' });

  it('renders media straight from the href and never buffers it', async () => {
    // An earlier draft fetched EVERY preview into a Blob, justified by the
    // download route's `attachment` disposition. That route serves image,
    // audio and video INLINE (services/w2/files.ts), so buffering them bought
    // nothing and cost a full copy of, say, a 500 MB video before first frame.
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    render(<FilesExplorerScreen port={portWith([png])} />);
    await openPreview(png.name);

    const img = (await screen.findByAltText(png.name)) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(`/v2/files/${png.entityId}/download`);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('buffers a PDF, because attachment really does stop an iframe rendering', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, blob: async () => new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
    })));
    render(<FilesExplorerScreen port={portWith([pdf])} />);
    await openPreview(pdf.name);

    const frame = (await screen.findByTitle(`Preview of ${pdf.name}`)) as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe('blob:stub');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('REVOKES the object URL when the preview closes', async () => {
    // The header docblock claims one URL per preview, revoked. Asserted here
    // rather than merely asserted in prose: a leaked object URL pins the whole
    // blob for the life of the document.
    const { fireEvent } = await import('@testing-library/react');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, blob: async () => new Blob(['%PDF-1.4'], { type: 'application/pdf' }),
    })));
    render(<FilesExplorerScreen port={portWith([pdf])} />);
    await openPreview(pdf.name);
    await screen.findByTitle(`Preview of ${pdf.name}`);

    fireEvent.click(screen.getByLabelText('Close preview'));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stub'));
    vi.unstubAllGlobals();
  });
});

describe('project files reach their bytes without an href', () => {
  const projectFile = entry({
    name: 'index.ts',
    path: '/srv/proj/index.ts',
    mime: 'text/plain',
    entityId: null,
    projectId: 'p1' as never,
  });

  function projectPort(bytes: ExplorerBytes): FilesExplorerPort {
    return portWith([projectFile], {
      roots: async () => [projectRoot],
      downloadHref: () => null,
      readBytes: async () => bytes,
    });
  }

  it('offers a download for an entry with no URL at all', async () => {
    const port = projectPort({
      blob: new Blob(['export const a = 1;']),
      mime: 'text/plain',
      truncated: false,
    });
    render(<FilesExplorerScreen port={port} />);
    // The row action exists even though downloadHref answered null — the old
    // screen rendered nothing here, so a project file could not be saved.
    expect(await screen.findByLabelText(`Download ${projectFile.name}`)).toBeTruthy();
  });

  it('REFUSES to save a truncated read rather than writing a short file', async () => {
    const notices: string[] = [];
    const port = projectPort({
      blob: new Blob(['first five megabytes only']),
      mime: 'text/plain',
      truncated: true,
    });
    const { fireEvent } = await import('@testing-library/react');
    render(<FilesExplorerScreen port={port} onNotice={(t) => notices.push(t)} />);
    fireEvent.click(await screen.findByLabelText(`Download ${projectFile.name}`));

    await waitFor(() => expect(notices).toContain(EXPLORER_REASONS.DOWNLOAD_TOO_LARGE));
    // The whole point: nothing was saved.
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});

describe('a folder can be downloaded as a zip', () => {
  it('puts an archive link on directory rows and on the root', async () => {
    const dir = entry({ name: 'src', path: '/srv/proj/src', type: 'dir', entityId: null, projectId: 'p1' as never, mime: null });
    const port = portWith([dir], {
      roots: async () => [projectRoot],
      downloadHref: () => null,
      archiveHref: (target) =>
        'kind' in target
          ? '/v2/projects/p1/files/archive'
          : `/v2/projects/p1/files/archive?path=${encodeURIComponent(target.path)}`,
    });
    render(<FilesExplorerScreen port={port} />);

    const rowLink = (await screen.findByLabelText('Download src as a zip archive')) as HTMLAnchorElement;
    expect(rowLink.getAttribute('href')).toContain('files/archive?path=');
    const rootLink = screen.getByText('Download zip') as HTMLAnchorElement;
    expect(rootLink.getAttribute('href')).toBe('/v2/projects/p1/files/archive');
  });

  it('offers no archive link where there is no archive capability', async () => {
    const dir = entry({ name: 'src', type: 'dir', entityId: null, mime: null });
    render(<FilesExplorerScreen port={portWith([dir])} />);
    await screen.findByText('src');
    expect(screen.queryByLabelText('Download src as a zip archive')).toBeNull();
    expect(screen.queryByText('Download zip')).toBeNull();
  });
});

describe('renderer selection is closed and type-driven', () => {
  it('maps the types a browser can honestly show', () => {
    expect(rendererFor('image/png')).toBe('image');
    expect(rendererFor('application/pdf')).toBe('pdf');
    expect(rendererFor('text/markdown')).toBe('text');
    expect(rendererFor('application/json')).toBe('text');
    expect(rendererFor('audio/mpeg')).toBe('audio');
    expect(rendererFor('video/mp4')).toBe('video');
    expect(rendererFor('text/plain; charset=utf-8')).toBe('text');
  });

  it('never renders an SVG, and shows HTML as source rather than as a document', () => {
    expect(rendererFor('image/svg+xml')).toBeNull();
    // `text/html` maps to the <pre> renderer, so markup off a disk can never
    // reach an iframe. This is the assertion that keeps §4.4 honest here; an
    // earlier draft tested a separate predicate that no input could reach.
    expect(rendererFor('text/html')).toBe('text');
  });

  it('answers null for anything it cannot show, rather than guessing', () => {
    expect(rendererFor('application/octet-stream')).toBeNull();
    expect(rendererFor(null)).toBeNull();
    expect(rendererFor('application/zip')).toBeNull();
  });
});

describe('sorting and filtering', () => {
  const rows = [
    entry({ name: 'b.txt', sizeBytes: 100, modifiedAt: '2026-01-01T00:00:00Z' }),
    entry({ name: 'a.txt', sizeBytes: 300, modifiedAt: '2026-03-01T00:00:00Z' }),
    entry({ name: 'zdir', type: 'dir', sizeBytes: null, modifiedAt: null }),
  ];

  it('keeps directories first in every sort', () => {
    for (const key of ['name', 'size', 'modified'] as const) {
      expect(sortEntries(rows, key)[0]!.name, key).toBe('zdir');
    }
  });

  it('sorts unknown size and date LAST, never as zero', () => {
    // A directory has no size; ranking it above a 300-byte file because
    // `null < 300` would be the numeric form of the lie the dash avoids.
    const files = sortEntries(rows, 'size').filter((r) => r.type === 'file');
    expect(files.map((r) => r.name)).toEqual(['a.txt', 'b.txt']);
    const byDate = sortEntries(rows, 'modified').filter((r) => r.type === 'file');
    expect(byDate.map((r) => r.name)).toEqual(['a.txt', 'b.txt']);
  });

  it('filters case-insensitively on the display name', () => {
    expect(filterEntries(rows, 'A.TX').map((r) => r.name)).toEqual(['a.txt']);
    expect(filterEntries(rows, '').map((r) => r.name)).toEqual(rows.map((r) => r.name));
  });

  it('distinguishes "filtered to nothing" from "empty folder"', async () => {
    const { fireEvent } = await import('@testing-library/react');
    render(<FilesExplorerScreen port={portWith([entry({ name: 'a.txt' })])} />);
    fireEvent.change(await screen.findByLabelText('Filter this folder by name'), {
      target: { value: 'nothing-matches-this' },
    });
    expect(await screen.findByTestId('fx-filtered-empty')).toBeTruthy();
    expect(screen.queryByTestId('fx-measured-empty')).toBeNull();
  });
});

describe('import progress is measured, not mimed', () => {
  it('names the phase before any byte count would be meaningful', () => {
    expect(importCaption({ phase: 'hashing', filesDone: 0, filesTotal: 1208, bytesDone: 0, bytesTotal: 99 }))
      .toBe('Checking 1208 files…');
    expect(importCaption({ phase: 'starting', filesDone: 0, filesTotal: 3, bytesDone: 0, bytesTotal: 9 }))
      .toContain('Reserving');
  });

  it('reports real counts once uploading, because the denominator is known', () => {
    const caption = importCaption({
      phase: 'uploading',
      filesDone: 42,
      filesTotal: 1208,
      bytesDone: 1024,
      bytesTotal: 4096,
    });
    expect(caption).toContain('42 of 1208 files');
    expect(caption).toContain('1 KB of 4 KB');
  });
});

describe('tree mode is a tree', () => {
  const dir = entry({ name: 'src', path: 'src', type: 'dir', mime: null, entityId: null });
  const child = entry({ name: 'deep.ts', path: 'src/deep.ts', mime: 'text/plain' });

  it('expands a folder in place and loads its children only when asked', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const list = vi.fn(async (_root, path: string) =>
      path === 'src' ? { entries: [child], truncated: false } : { entries: [dir], truncated: false },
    );
    render(<FilesExplorerScreen port={portWith([dir], { list: list as never })} />);

    // Collapsed to start: children are NOT fetched on mode switch, or a root
    // with 200 folders would storm the node before the user asked for any.
    fireEvent.click(await screen.findByText('tree'));
    expect(await screen.findByLabelText('Expand src')).toBeTruthy();
    expect(screen.queryByText('deep.ts')).toBeNull();

    fireEvent.click(screen.getByLabelText('Expand src'));
    expect(await screen.findByText('deep.ts')).toBeTruthy();
    // The nesting is real: the child sits in a `group` INSIDE the expanded
    // treeitem, which is what a screen reader needs to announce a level at
    // all. Scoped to the tree because the toolbars are `role=group` too.
    const tree = screen.getByRole('tree');
    const branch = within(tree).getByRole('group');
    expect(within(branch).getByText('deep.ts')).toBeTruthy();
  });

  it('reports a branch that could not be read, rather than showing it empty', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const list = vi.fn(async (_root, path: string) => {
      if (path === 'src') throw new Error('nope');
      return { entries: [dir], truncated: false };
    });
    render(<FilesExplorerScreen port={portWith([dir], { list: list as never })} />);
    fireEvent.click(await screen.findByText('tree'));
    fireEvent.click(await screen.findByLabelText('Expand src'));

    // "Empty" and "unreadable" are different facts and must not share a render.
    expect(await screen.findByText(/Could not read src/)).toBeTruthy();
    expect(screen.queryByText('Empty.')).toBeNull();
  });
});
