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

  it('says plainly that no project is linked, rather than rendering an empty tree', async () => {
    render(<FilesScreen seam={seamWith(listing())} projects={[]} />);
    expect(await screen.findByTestId('files-no-projects')).toBeTruthy();
  });

  it('offers a root picker only when there is more than one project', async () => {
    const seam = seamWith(listing({ files: [FILE] }));
    const { rerender } = render(<FilesScreen seam={seam} projects={PROJECTS} />);
    await screen.findByTestId('files-entry-README.md');
    expect(screen.queryByTestId('files-root-select')).toBeNull();

    rerender(<FilesScreen seam={seam} projects={[...PROJECTS, { id: 'p2', name: 'other' }]} />);
    expect(screen.getByTestId('files-root-select')).toBeTruthy();
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
