// @vitest-environment jsdom
/**
 * FilesExplorerScreen — honest states, breadcrumbs, modes, verbs, conflicts.
 * Driven through a controllable stub PORT (plain values and callbacks; the
 * component cannot tell it from a wired one — that is the port law).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesExplorerScreen, breadcrumbSegments, formatSize } from './FilesExplorerScreen';
import { EXPLORER_REASONS, type ExplorerEntry, type ExplorerRoot, type FilesExplorerPort } from './port';

afterEach(cleanup);

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
    sizeBytes: 1234,
    modifiedAt: '2026-08-10T00:00:00Z',
    mime: 'text/plain',
    entityId: `e:${partial.name}` as never,
    trashed: false,
    version: 1,
    ...partial,
  };
}

function stubPort(overrides?: Partial<FilesExplorerPort>): FilesExplorerPort {
  return {
    roots: async () => [libraryRoot, projectRoot],
    list: async () => ({ entries: [entry({ name: 'a.txt' }), entry({ name: 'b.png', mime: 'image/png' })], truncated: false }),
    downloadHref: (e) => (e.entityId ? `/v2/files/${e.entityId}/download` : null),
    ...overrides,
  };
}


/**
 * A folder-import task double. `subscribe`/`progress` are part of the task
 * contract now (the screen reports measured counts, not a spinner), so a
 * double that omits them is not a smaller double — it is a different type,
 * and the screen would throw on it exactly as it would on a real seam that
 * lied about its shape.
 */
function importTaskDouble(
  outcome: { projectName: string; fileCount: number; replacedCount: number; merged: boolean },
  overrides: { result?: Promise<never> } = {},
) {
  const progress = {
    phase: 'uploading' as const,
    filesDone: 0,
    filesTotal: outcome.fileCount,
    bytesDone: 0,
    bytesTotal: 0,
  };
  return {
    result: overrides.result ?? Promise.resolve(outcome),
    cancel: () => {},
    subscribe: (listener: (p: typeof progress) => void) => {
      listener(progress);
      return () => {};
    },
    progress: () => progress,
  };
}

describe('honest states — every void says why', () => {
  it('renders the measured empty, not a silent blank', async () => {
    render(
      <FilesExplorerScreen port={stubPort({ list: async () => ({ entries: [], truncated: false }) })} />,
    );
    expect((await screen.findByTestId('fx-measured-empty')).textContent).toMatch(/empty/i);
  });

  it('renders an error WITH retry, and retry refetches', async () => {
    let calls = 0;
    const port = stubPort({
      list: async () => {
        calls += 1;
        if (calls === 1) throw new Error('Could not read this folder.');
        return { entries: [entry({ name: 'ok.txt' })], truncated: false };
      },
    });
    render(<FilesExplorerScreen port={port} />);
    // Generous timeout: under a loaded parallel run the default 1s produced
    // a phantom red while the same file alone is green.
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }, { timeout: 5000 }));
    expect(await screen.findByText('ok.txt')).toBeTruthy();
  });

  it('says when the server truncated the listing', async () => {
    render(
      <FilesExplorerScreen
        port={stubPort({ list: async () => ({ entries: [entry({ name: 'a.txt' })], truncated: true }) })}
      />,
    );
    expect((await screen.findByTestId('fx-truncated')).textContent).toMatch(/cut by the server/i);
  });

  it('a root that cannot be browsed states its reason instead of an empty list', async () => {
    render(
      <FilesExplorerScreen
        port={stubPort({
          roots: async () => [
            { ...projectRoot, unavailableReason: EXPLORER_REASONS.PROJECT_BROWSE_UNAVAILABLE },
          ],
        })}
      />,
    );
    expect(await screen.findByText(EXPLORER_REASONS.PROJECT_BROWSE_UNAVAILABLE)).toBeTruthy();
  });
});

describe('roots, breadcrumbs, modes', () => {
  it('lists both roots and switching resets the path', async () => {
    const seen: string[] = [];
    const port = stubPort({
      list: async (root, path) => {
        seen.push(`${root.id}:${path}`);
        if (root.kind === 'project' && path === '') {
          return { entries: [entry({ name: 'src', path: 'src', type: 'dir', entityId: null, version: null })], truncated: false };
        }
        return { entries: [entry({ name: 'inner.ts', path: 'src/inner.ts', entityId: null, version: null })], truncated: false };
      },
    });
    render(<FilesExplorerScreen port={port} />);
    const rail = await screen.findByRole('complementary', { name: 'File roots' });
    fireEvent.click(await within(rail).findByRole('button', { name: 'tm8' }));
    // descend into the folder, then breadcrumb back to the root
    fireEvent.click(await screen.findByRole('button', { name: 'src' }));
    expect(await screen.findByText('inner.ts')).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumbs' });
    expect(crumbs.textContent).toContain('src');
    fireEvent.click(within(crumbs).getByRole('button', { name: 'tm8' }));
    await waitFor(() => expect(seen).toContain('project:p1:'));
    expect(seen).toContain('project:p1:src');
  });

  it('gallery mode draws image tiles from the port href and no <img> for non-images', async () => {
    render(<FilesExplorerScreen port={stubPort()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'gallery' }));
    /* React 19: the listing lands in a later commit than the mode flip —
       wait for the tiles rather than reading the DOM synchronously. */
    await waitFor(() => expect(document.querySelectorAll('img.fx-thumb')).toHaveLength(1));
    const imgs = document.querySelectorAll('img.fx-thumb');
    expect(imgs).toHaveLength(1);
    expect((imgs[0] as HTMLImageElement).src).toContain('/v2/files/e:b.png/download');
  });

  it('tree mode renders a real tree role', async () => {
    render(<FilesExplorerScreen port={stubPort()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'tree' }));
    expect(await screen.findByRole('tree', { name: 'Folder tree' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(2));
  });
});

describe('verbs — real when the port carries them, disabled-with-reason when not', () => {
  it('download links carry the port href verbatim', async () => {
    render(<FilesExplorerScreen port={stubPort()} />);
    const link = await screen.findByRole('link', { name: 'Download a.txt' });
    expect(link.getAttribute('href')).toBe('/v2/files/e:a.txt/download');
  });

  it('rename submits the port rename with the typed name', async () => {
    const rename = vi.fn(async () => {});
    render(<FilesExplorerScreen port={stubPort({ rename })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename a.txt' }));
    const input = screen.getByLabelText('New name');
    fireEvent.change(input, { target: { value: 'renamed.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
    expect(rename.mock.calls[0]![1]).toBe('renamed.txt');
  });

  it('trash and the Trash tab restore round-trip through the port', async () => {
    const trash = vi.fn(async () => {});
    const restore = vi.fn(async () => {});
    const port = stubPort({
      trash,
      restore,
      list: async (_root, _path, opts) =>
        opts?.trashed
          ? { entries: [entry({ name: 'gone.txt', trashed: true })], truncated: false }
          : { entries: [entry({ name: 'a.txt' })], truncated: false },
    });
    render(<FilesExplorerScreen port={port} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Move a.txt to trash' }));
    await waitFor(() => expect(trash).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Trash' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore gone.txt' }));
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
  });

  it('no importFolder capability ⇒ Import folder is DISABLED with the R7 reason', async () => {
    render(<FilesExplorerScreen port={stubPort()} />);
    const btn = (await screen.findByRole('button', { name: 'Import folder' })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(EXPLORER_REASONS.FOLDER_IMPORT_UNAVAILABLE);
  });

  it('importFolderBlockedReason ⇒ Import folder is DISABLED with the TRUTHFUL role reason, not the not-served one', async () => {
    render(
      <FilesExplorerScreen
        port={stubPort({ importFolderBlockedReason: EXPLORER_REASONS.FOLDER_IMPORT_FORBIDDEN })}
      />,
    );
    const btn = (await screen.findByRole('button', { name: 'Import folder' })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(EXPLORER_REASONS.FOLDER_IMPORT_FORBIDDEN);
  });

  it('with importFolder present a directory pick becomes ONE import per top folder and reports replacedCount (R8)', async () => {
    const importStart = vi.fn(
      (
        _files: ReadonlyArray<{ file: File; relativePath: string }>,
        _rootName: string,
      ) => ({
        ...importTaskDouble({ projectName: 'proj', fileCount: 2, replacedCount: 2, merged: true }),
      }),
    );
    const onNotice = vi.fn();
    render(
      <FilesExplorerScreen
        port={stubPort({ importFolder: { start: importStart }, upload: undefined })}
        onNotice={onNotice}
      />,
    );
    const input = (await screen.findByTestId('fx-dir-input')) as HTMLInputElement;
    const f1 = new File(['1'], 'x.txt');
    Object.defineProperty(f1, 'webkitRelativePath', { value: 'proj/x.txt' });
    const f2 = new File(['2'], 'y.txt');
    Object.defineProperty(f2, 'webkitRelativePath', { value: 'proj/sub/y.txt' });
    Object.defineProperty(input, 'files', { value: [f1, f2] });
    fireEvent.change(input);
    await waitFor(() => expect(importStart).toHaveBeenCalledTimes(1));
    const [files, rootName] = importStart.mock.calls[0]! as unknown as [
      Array<{ relativePath: string }>,
      string,
    ];
    expect(rootName).toBe('proj');
    expect(files.map((f) => f.relativePath)).toEqual(['proj/x.txt', 'proj/sub/y.txt']);
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('2 existing files replaced')),
    );
  });

  it('a successful import RELOADS the roots rail — the linked project must appear without a remount', async () => {
    let rootsCalls = 0;
    const port = stubPort({
      roots: async () => {
        rootsCalls += 1;
        return rootsCalls > 1 ? [libraryRoot, projectRoot] : [libraryRoot];
      },
      upload: undefined,
      importFolder: {
        start: () => importTaskDouble({ projectName: 'proj', fileCount: 1, replacedCount: 0, merged: false }),
      },
    });
    render(<FilesExplorerScreen port={port} />);
    const input = (await screen.findByTestId('fx-dir-input')) as HTMLInputElement;
    const f1 = new File(['1'], 'x.txt');
    Object.defineProperty(f1, 'webkitRelativePath', { value: 'proj/x.txt' });
    Object.defineProperty(input, 'files', { value: [f1] });
    fireEvent.change(input);
    await waitFor(() => expect(rootsCalls).toBeGreaterThan(1));
  });
});

describe('conflict preflight dialog', () => {
  it('offers keep-both / replace / skip when a pick collides, and skip uploads nothing conflicted', async () => {
    const started: string[] = [];
    const port = stubPort({
      upload: {
        preservesPaths: false,
        start: (file) => {
          started.push(file.name);
          return { result: new Promise(() => {}), cancel() {} };
        },
      },
    });
    render(<FilesExplorerScreen port={port} />);
    /* The collision is judged against the LISTING — under React 19 the input
       appears before the listing's commit, so earn the listing first. */
    await screen.findByText('a.txt');
    const input = (await screen.findByTestId('fx-file-input')) as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['1'], 'a.txt'), new File(['2'], 'new.txt')] });
    fireEvent.change(input);
    const dialog = await screen.findByTestId('fx-conflict-dialog');
    expect(dialog.textContent).toContain('1 item');
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(started).toEqual(['new.txt']));
  });
});

describe('upload queue ledger', () => {
  it('renders per-item status and cancel/retry controls', async () => {
    let fail!: (e: unknown) => void;
    const port = stubPort({
      upload: {
        preservesPaths: false,
        start: () => ({
          result: new Promise((_ok, err) => {
            fail = err;
          }),
          cancel() {},
        }),
      },
    });
    render(<FilesExplorerScreen port={port} />);
    /* The collision is judged against the LISTING — under React 19 the input
       appears before the listing's commit, so earn the listing first. */
    await screen.findByText('a.txt');
    const input = (await screen.findByTestId('fx-file-input')) as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['1'], 'solo.txt')] });
    fireEvent.change(input);
    const queue = await screen.findByRole('region', { name: 'Upload queue' });
    expect(queue.textContent).toContain('solo.txt');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    fail(Object.assign(new Error('x'), { code: 'payload_too_large' }));
    await screen.findByText(/larger than the allowed upload size/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('first run — no project linked', () => {
  it('names the link-a-project path when only the Library root exists', async () => {
    const port = stubPort({
      roots: async () => [libraryRoot],
      list: async () => ({ entries: [], truncated: false }),
    });
    render(<FilesExplorerScreen port={port} />);
    // The rail says a project CAN live here and names the real way to add one.
    const hint = await screen.findByTestId('fx-no-projects');
    expect(hint.textContent).toContain('tm8 project link');
    // The empty Library says what the Library IS, not a bare "empty".
    const empty = await screen.findByTestId('fx-measured-empty');
    expect(empty.textContent).toContain('It holds files shared across this space');
  });

  it('drops the hint once a project root is present', async () => {
    render(<FilesExplorerScreen port={stubPort({ list: async () => ({ entries: [], truncated: false }) })} />);
    await screen.findByTestId('files-explorer');
    await waitFor(() => expect(screen.queryByTestId('fx-no-projects')).toBeNull());
  });
});

describe('pure derivations', () => {
  it('formatSize renders a dash for null — not-known is never 0', () => {
    expect(formatSize(null)).toBe('—');
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(10 * 1024 * 1024)).toBe('10 MB');
  });
  it('breadcrumbSegments accumulates paths', () => {
    expect(breadcrumbSegments('')).toEqual([]);
    expect(breadcrumbSegments('a/b/c')).toEqual([
      { label: 'a', path: 'a' },
      { label: 'b', path: 'a/b' },
      { label: 'c', path: 'a/b/c' },
    ]);
  });
});
