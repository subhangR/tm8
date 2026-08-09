// @vitest-environment jsdom
import type { ProjectFileContent, ProjectFileListing } from '@tm8/contract';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Seam } from '../data/seam';
import { FilesScreen } from './FilesScreen';

/**
 * FILES-DESIGN §8. These are RENDER claims, which jsdom can settle. Layout
 * claims (pane widths, scrolling) are deliberately absent — jsdom passes a pane
 * that is visually clipped, so asserting geometry here would manufacture false
 * confidence.
 *
 * The cases are chosen because they are the ones a careless implementation
 * collapses into one another.
 */

const PROJECTS = [{ id: 'proj-1', name: 'demo-project' }];
const ROOT = '/w/demo-project';

function listing(over: Partial<ProjectFileListing> = {}): ProjectFileListing {
  return {
    projectId: 'proj-1',
    workingDir: ROOT,
    path: ROOT,
    parentPath: null,
    separator: '/',
    directories: [],
    files: [],
    truncated: false,
    maxSizeBytes: 512 * 1024 * 1024,
    ...over,
  };
}

function content(over: Partial<ProjectFileContent> = {}): ProjectFileContent {
  return {
    projectId: 'proj-1',
    path: `${ROOT}/README.md`,
    mime: 'text/markdown',
    sizeBytes: 0,
    encoding: 'utf8',
    text: '',
    base64: null,
    refusal: null,
    maxInlineBytes: 5 * 1024 * 1024,
    ...over,
  };
}

function seamWith(list: ProjectFileListing, read?: ProjectFileContent): Seam {
  return {
    projectFiles: {
      list: vi.fn(async () => list),
      read: vi.fn(async () => read ?? content()),
      attach: vi.fn(),
    },
  } as unknown as Seam;
}

const DIR = { name: 'src', path: `${ROOT}/src` };
const FILE = {
  name: 'README.md', path: `${ROOT}/README.md`, sizeBytes: 12,
  modifiedAt: '2026-08-09T00:00:00.000Z', mime: 'text/markdown', attachable: true,
};

describe('FilesScreen — what it can and cannot reach', () => {
  it('says the capability is ABSENT when the seam has no project-files group', async () => {
    // The group is optional (a fixture seam has no filesystem). Drawing an
    // empty tree here would read as "this project has no files" — a lie.
    render(<FilesScreen seam={{} as Seam} projects={PROJECTS} />);
    expect(await screen.findByTestId('files-no-port')).toBeTruthy();
  });

  it('says plainly that NOTHING is browsable, naming both kinds of root', async () => {
    render(<FilesScreen seam={seamWith(listing())} projects={[]} />);
    const empty = await screen.findByTestId('files-no-roots');
    // Not "no projects": a Space with no project may still have folders, and a
    // user told only about projects will not learn the other half exists.
    expect(empty.textContent).toContain('LINKED PROJECT');
    expect(empty.textContent).toContain('SPACE FOLDER');
  });

  it('states that Space folders are unreachable in this build, rather than showing none', async () => {
    // MEASURED on 541951a: the seam carries no `spaceFolders` group. An empty
    // folder list would read as "you have uploaded nothing" — a different fact
    // with a different remedy.
    render(<FilesScreen seam={seamWith(listing({ files: [FILE] }))} projects={PROJECTS} />);
    const off = await screen.findByTestId('files-space-folders-off');
    expect(off.textContent).toContain('cannot read Space folders');
  });
});

describe('FilesScreen — the listing', () => {
  it('distinguishes an EMPTY directory from a failed read', async () => {
    render(<FilesScreen seam={seamWith(listing())} projects={PROJECTS} />);
    expect(await screen.findByTestId('files-empty-dir')).toBeTruthy();
    expect(screen.queryByTestId('files-list-error')).toBeNull();
  });

  it('surfaces a refused listing as an error, not as an empty directory', async () => {
    const seam = {
      projectFiles: {
        list: vi.fn(async () => { throw new Error('working directory does not exist'); }),
        read: vi.fn(async () => content()),
        attach: vi.fn(),
      },
    } as unknown as Seam;
    render(<FilesScreen seam={seam} projects={PROJECTS} />);
    expect((await screen.findByTestId('files-list-error')).textContent)
      .toContain('does not exist');
    expect(screen.queryByTestId('files-empty-dir')).toBeNull();
  });

  it('walks into a directory by its ABSOLUTE path', async () => {
    const seam = seamWith(listing({ directories: [DIR] }));
    render(<FilesScreen seam={seam} projects={PROJECTS} />);
    fireEvent.click(await screen.findByTestId('files-dir-src'));
    await waitFor(() => {
      expect(seam.projectFiles?.list).toHaveBeenCalledWith('proj-1', `${ROOT}/src`);
    });
  });

  it('renders breadcrumbs from the path RELATIVE to the working directory', async () => {
    render(
      <FilesScreen
        seam={seamWith(listing({ path: `${ROOT}/src/deep`, parentPath: `${ROOT}/src`, files: [FILE] }))}
        projects={PROJECTS}
      />,
    );
    const crumbs = await screen.findByTestId('files-breadcrumbs');
    // The absolute prefix is the node's business, not the reader's.
    expect(crumbs.textContent).toContain('src');
    expect(crumbs.textContent).toContain('deep');
    expect(crumbs.textContent).not.toContain('/w/');
  });

  it('says a truncated directory is truncated', async () => {
    render(<FilesScreen seam={seamWith(listing({ files: [FILE], truncated: true }))} projects={PROJECTS} />);
    expect(await screen.findByTestId('files-truncated')).toBeTruthy();
  });
});

describe('FilesScreen — content, and the ways it can be absent', () => {
  it('renders an EMPTY file as empty text, NOT as a refusal', async () => {
    // The collapse this catches: '' and 'withheld' both draw nothing if the
    // refusal branch is written as a falsiness check on `text`.
    render(
      <FilesScreen
        seam={seamWith(listing({ files: [FILE] }), content({ text: '', sizeBytes: 0 }))}
        projects={PROJECTS}
      />,
    );
    fireEvent.click(await screen.findByTestId('files-entry-README.md'));
    expect((await screen.findByTestId('files-text')).textContent).toBe('');
    expect(screen.queryByTestId('files-refusal')).toBeNull();
  });

  it('NAMES a secret-pattern refusal instead of showing a blank pane', async () => {
    render(
      <FilesScreen
        seam={seamWith(
          listing({ files: [FILE] }),
          content({
            encoding: 'none', text: null,
            refusal: { reason: 'secret-pattern', detail: 'withheld by the secret-name policy' },
          }),
        )}
        projects={PROJECTS}
      />,
    );
    fireEvent.click(await screen.findByTestId('files-entry-README.md'));
    const refusal = await screen.findByTestId('files-refusal');
    expect(refusal.getAttribute('data-reason')).toBe('secret-pattern');
    expect(refusal.textContent).toContain('secret-name policy');
    expect(screen.queryByTestId('files-text')).toBeNull();
  });

  it('names each refusal reason DISTINCTLY — they are not one state', async () => {
    // too-large, binary and outside-root have different remedies. Collapsing
    // them into one "cannot show this" is the defect.
    for (const [reason, expected] of [
      ['too-large', 'Too large'],
      ['binary-not-previewable', 'Binary file'],
      ['outside-root', 'outside the project working directory'],
    ] as const) {
      const view = render(
        <FilesScreen
          seam={seamWith(
            listing({ files: [FILE] }),
            content({ encoding: 'none', text: null, refusal: { reason, detail: 'd' } }),
          )}
          projects={PROJECTS}
        />,
      );
      fireEvent.click(await screen.findByTestId('files-entry-README.md'));
      const refusal = await screen.findByTestId('files-refusal');
      expect(refusal.getAttribute('data-reason')).toBe(reason);
      expect(refusal.textContent).toContain(expected);
      view.unmount();
    }
  });

  it('renders text into a <pre>, never as markup', async () => {
    render(
      <FilesScreen
        seam={seamWith(listing({ files: [FILE] }), content({ text: '<img src=x onerror="alert(1)">' }))}
        projects={PROJECTS}
      />,
    );
    fireEvent.click(await screen.findByTestId('files-entry-README.md'));
    const pre = await screen.findByTestId('files-text');
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toContain('<img src=x');
    expect(pre.querySelector('img')).toBeNull();
  });

  it('reads a file by its ABSOLUTE path', async () => {
    const seam = seamWith(listing({ files: [FILE] }));
    render(<FilesScreen seam={seam} projects={PROJECTS} />);
    fireEvent.click(await screen.findByTestId('files-entry-README.md'));
    await waitFor(() => {
      expect(seam.projectFiles?.read).toHaveBeenCalledWith('proj-1', `${ROOT}/README.md`);
    });
  });
});

/* ==========================================================================
 * THE TWO ROOT KINDS — the central UX claim of this lane.
 * ======================================================================== */

const FOLDER = { id: 'sf-1', name: 'design-assets' };

function folderListing(over: Partial<SpaceFolderListing> = {}): SpaceFolderListing {
  return {
    path: '',
    parentPath: null,
    separator: '/',
    directories: [],
    files: [{ name: 'logo.svg', path: 'logo.svg', sizeBytes: 40 }],
    truncated: false,
    ...over,
  };
}

function seamWithBoth(over: Partial<SpaceFoldersPort> = {}): Seam {
  return {
    projectFiles: {
      list: vi.fn(async () => listing({ files: [FILE] })),
      read: vi.fn(async () => content()),
      attach: vi.fn(),
    },
    spaceFolders: {
      list: vi.fn(async () => [FOLDER]),
      create: vi.fn(async () => FOLDER),
      upload: vi.fn(async () => ({ expandedFiles: 0, totalBytes: 0, skipped: [] })),
      browse: vi.fn(async () => folderListing()),
      read: vi.fn(async () => ({
        path: 'logo.svg', mime: 'text/plain', sizeBytes: 3,
        encoding: 'utf8' as const, text: 'hi', base64: null, refusal: null,
      })),
      ...over,
    },
  } as unknown as Seam;
}

describe('FilesScreen — two kinds of root, never one anonymous tree', () => {
  it('STATES that a linked project is LIVE, not merely which project it is', async () => {
    render(<FilesScreen seam={seamWith(listing({ files: [FILE] }))} projects={PROJECTS} />);
    const banner = await screen.findByTestId('files-root-kind');
    expect(banner.getAttribute('data-kind')).toBe('project');
    expect(banner.textContent).toContain('LIVE');
    expect(banner.textContent).toContain('change while you look at it');
  });

  it('groups the picker BY KIND, with each group naming its staleness', async () => {
    render(<FilesScreen seam={seamWithBoth()} projects={PROJECTS} spaceId="sp-1" />);
    const select = await screen.findByTestId('files-root-select');
    await waitFor(() => {
      expect(select.querySelectorAll('optgroup').length).toBe(2);
    });
    const labels = [...select.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'));
    expect(labels[0]).toContain('live on this node');
    expect(labels[1]).toContain('uploaded snapshots');
  });

  it('switches the banner to SNAPSHOT when a Space folder is selected — the two do NOT collapse', async () => {
    const seam = seamWithBoth();
    render(<FilesScreen seam={seam} projects={PROJECTS} spaceId="sp-1" />);
    const select = await screen.findByTestId('files-root-select');
    await waitFor(() => expect(select.querySelectorAll('option').length).toBe(2));

    fireEvent.change(select, { target: { value: 'folder:sf-1' } });

    const banner = await screen.findByTestId('files-root-kind');
    await waitFor(() => expect(banner.getAttribute('data-kind')).toBe('space-folder'));
    expect(banner.textContent).toContain('SNAPSHOT');
    expect(banner.textContent).not.toContain('LIVE —');
    // And it reads through the OTHER port: a snapshot is not on the node's disk.
    await waitFor(() => expect(seam.spaceFolders?.browse).toHaveBeenCalledWith('sf-1', undefined));
  });

  it('keeps browsing linked projects when Space folders cannot be listed', async () => {
    const seam = seamWithBoth({
      list: vi.fn(async () => { throw new Error('folder store is offline'); }),
    });
    render(<FilesScreen seam={seam} projects={PROJECTS} spaceId="sp-1" />);
    expect((await screen.findByTestId('files-folders-error')).textContent)
      .toContain('folder store is offline');
    // The live root is untouched by the other kind's failure.
    expect(await screen.findByTestId('files-entry-README.md')).toBeTruthy();
  });

  it('refuses folder upload into a LIVE project, and says why rather than hiding it', async () => {
    render(<FilesScreen seam={seamWithBoth()} projects={PROJECTS} spaceId="sp-1" />);
    const upload = await screen.findByTestId('folder-upload');
    await waitFor(() => {
      expect(upload.textContent).toContain('Folders upload into a Space folder, not into a project');
    });
  });
});

/* ==========================================================================
 * KEYBOARD NAVIGATION — a behaviour, so `document.activeElement` is asserted,
 * not merely that a handler was called.
 * ======================================================================== */

describe('FilesScreen — the tree is navigable from the keyboard', () => {
  const TREE_LISTING = listing({
    directories: [DIR],
    files: [FILE, { ...FILE, name: 'LICENSE', path: `${ROOT}/LICENSE` }],
  });

  it('is ONE tabstop, not one per row', async () => {
    render(<FilesScreen seam={seamWith(TREE_LISTING)} projects={PROJECTS} />);
    await screen.findByTestId('files-entry-README.md');
    const rows = screen.getByTestId('files-tree').querySelectorAll('[role="treeitem"]');
    expect(rows.length).toBe(3);
    expect([...rows].filter((row) => row.getAttribute('tabindex') === '0').length).toBe(1);
  });

  it('moves REAL focus with the arrow keys', async () => {
    render(<FilesScreen seam={seamWith(TREE_LISTING)} projects={PROJECTS} />);
    const first = await screen.findByTestId('files-dir-src');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('files-entry-README.md'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByTestId('files-entry-LICENSE'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByTestId('files-entry-README.md'));
  });

  it('descends with ArrowRight and opens a file with Enter', async () => {
    const seam = seamWith(TREE_LISTING);
    render(<FilesScreen seam={seam} projects={PROJECTS} />);
    const dir = await screen.findByTestId('files-dir-src');
    fireEvent.keyDown(dir, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(seam.projectFiles?.list).toHaveBeenCalledWith('proj-1', `${ROOT}/src`);
    });

    const file = await screen.findByTestId('files-entry-README.md');
    fireEvent.keyDown(file, { key: 'Enter' });
    await waitFor(() => {
      expect(seam.projectFiles?.read).toHaveBeenCalledWith('proj-1', `${ROOT}/README.md`);
    });
  });
});

/* ==========================================================================
 * SAVING — offered only when bytes actually exist.
 * ======================================================================== */

describe('FilesScreen — saving a file', () => {
  it('offers a real download of the bytes it already read', async () => {
    render(
      <FilesScreen
        seam={seamWith(listing({ files: [FILE] }), content({ text: 'hello' }))}
        projects={PROJECTS}
      />,
    );
    fireEvent.click(await screen.findByTestId('files-entry-README.md'));
    const link = await screen.findByTestId('files-download');
    expect(link.getAttribute('download')).toBe('README.md');
    // btoa('hello') — the bytes on the link are the bytes that were read.
    expect(link.getAttribute('href')).toBe('data:text/markdown;base64,aGVsbG8=');
  });

  it('offers a download for an EMPTY file — empty is not refused', async () => {
    render(
      <FilesScreen
        seam={seamWith(listing({ files: [FILE] }), content({ text: '', sizeBytes: 0 }))}
        projects={PROJECTS}
      />,
    );
    fireEvent.click(await screen.findByTestId('files-entry-README.md'));
    expect((await screen.findByTestId('files-download')).getAttribute('href'))
      .toBe('data:text/markdown;base64,');
  });

  it('refuses to offer a download when the read was REFUSED, and says there are no bytes', async () => {
    render(
      <FilesScreen
        seam={seamWith(
          listing({ files: [FILE] }),
          content({ encoding: 'none', text: null, refusal: { reason: 'too-large', detail: 'd' } }),
        )}
        projects={PROJECTS}
      />,
    );
    fireEvent.click(await screen.findByTestId('files-entry-README.md'));
    await screen.findByTestId('files-refusal');
    expect(screen.queryByTestId('files-download')).toBeNull();
    expect(screen.getByTestId('files-content').textContent).toContain('no bytes to save');
  });
});
