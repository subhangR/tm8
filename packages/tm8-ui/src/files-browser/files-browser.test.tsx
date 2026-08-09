// @vitest-environment jsdom
import type { FileBrowseView, FileReadView, SpaceId } from '@tm8/contract';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Seam } from '../data/seam';
import { FilesScreen } from './FilesScreen';

/**
 * FILES-DESIGN §8. These are RENDER claims, which jsdom can settle. Every
 * layout claim (pane widths, scrolling) is deliberately absent — jsdom passes a
 * pane that is visually clipped, so asserting geometry here would manufacture
 * false confidence.
 *
 * The cases below are chosen because they are the ones a careless
 * implementation collapses into each other.
 */

const SPACE = 'space-1' as SpaceId;
const PROJECTS = [{ id: 'proj-1', name: 'demo-project' }];

function browseView(over: Partial<FileBrowseView> = {}): FileBrowseView {
  return {
    root: { projectId: 'proj-1', name: 'demo-project', trust: 'trusted' },
    path: '',
    parentPath: null,
    entries: [],
    totalEntries: 0,
    truncated: false,
    ...over,
  };
}

function readView(over: Partial<FileReadView> = {}): FileReadView {
  return {
    path: 'README.md',
    mimeType: 'text/markdown',
    sizeBytes: 0,
    encoding: 'utf8',
    text: '',
    base64: null,
    refusal: null,
    ...over,
  };
}

function seamWith(browse: FileBrowseView, read?: FileReadView): Seam {
  return {
    files: {
      browse: vi.fn(async () => browse),
      read: vi.fn(async () => read ?? readView()),
    },
  } as unknown as Seam;
}

const DIR_ENTRY = {
  name: 'src', kind: 'dir' as const, sizeBytes: null, modifiedAt: null,
  mimeType: null, masked: false, maskReason: null, symlink: false,
};
const FILE_ENTRY = {
  name: 'README.md', kind: 'file' as const, sizeBytes: 12, modifiedAt: null,
  mimeType: 'text/markdown', masked: false, maskReason: null, symlink: false,
};
const MASKED_ENTRY = {
  name: '.env', kind: 'file' as const, sizeBytes: 82, modifiedAt: null,
  mimeType: 'text/plain', masked: true, maskReason: 'secret-pattern' as const, symlink: false,
};

describe('FilesScreen — roots', () => {
  it('says plainly that nothing is linked rather than rendering an empty tree', async () => {
    // An empty file list and "no root exists" are different facts. Drawing the
    // first when the second is true sends the user looking for missing files.
    render(<FilesScreen seam={seamWith(browseView())} spaceId={SPACE} projects={[]} />);
    expect(await screen.findByTestId('files-no-projects')).toBeTruthy();
  });

  it('offers a root picker only when there is more than one project', async () => {
    const seam = seamWith(browseView({ entries: [FILE_ENTRY], totalEntries: 1 }));
    const { rerender } = render(
      <FilesScreen seam={seam} spaceId={SPACE} projects={PROJECTS} />,
    );
    await screen.findByTestId('files-entry-README.md');
    expect(screen.queryByTestId('files-root-select')).toBeNull();

    rerender(
      <FilesScreen
        seam={seam}
        spaceId={SPACE}
        projects={[...PROJECTS, { id: 'proj-2', name: 'other' }]}
      />,
    );
    expect(screen.getByTestId('files-root-select')).toBeTruthy();
  });
});

describe('FilesScreen — the listing', () => {
  it('LISTS a masked entry and marks it withheld, instead of hiding it', async () => {
    // §4.2. Hiding it would teach the reader that no .env exists — a lie they
    // would act on. This is the single most likely thing to be "cleaned up".
    render(
      <FilesScreen
        seam={seamWith(browseView({ entries: [MASKED_ENTRY], totalEntries: 1 }))}
        spaceId={SPACE}
        projects={PROJECTS}
      />,
    );
    const row = await screen.findByTestId('files-entry-.env');
    expect(row.getAttribute('data-masked')).toBe('true');
    expect(screen.getByTestId('files-masked-.env').textContent).toContain('withheld');
  });

  it('distinguishes an EMPTY directory from a failed read', async () => {
    render(
      <FilesScreen seam={seamWith(browseView())} spaceId={SPACE} projects={PROJECTS} />,
    );
    expect(await screen.findByTestId('files-empty-dir')).toBeTruthy();
    expect(screen.queryByTestId('files-list-error')).toBeNull();
  });

  it('reports how much of a truncated directory it is NOT showing', async () => {
    render(
      <FilesScreen
        seam={seamWith(browseView({ entries: [FILE_ENTRY], totalEntries: 1200, truncated: true }))}
        spaceId={SPACE}
        projects={PROJECTS}
      />,
    );
    expect((await screen.findByTestId('files-truncated')).textContent)
      .toContain('1 of 1200');
  });

  it('surfaces a refused listing as an error, not as an empty directory', async () => {
    const seam = {
      files: {
        browse: vi.fn(async () => { throw new Error('project working directory does not exist'); }),
        read: vi.fn(async () => readView()),
      },
    } as unknown as Seam;
    render(<FilesScreen seam={seam} spaceId={SPACE} projects={PROJECTS} />);
    expect((await screen.findByTestId('files-list-error')).textContent)
      .toContain('does not exist');
    expect(screen.queryByTestId('files-empty-dir')).toBeNull();
  });

  it('walks into a directory and asks the seam for that path', async () => {
    const seam = seamWith(browseView({ entries: [DIR_ENTRY], totalEntries: 1 }));
    render(<FilesScreen seam={seam} spaceId={SPACE} projects={PROJECTS} />);
    fireEvent.click(await screen.findByTestId('files-entry-src'));
    await waitFor(() => {
      expect(seam.files.browse).toHaveBeenCalledWith(SPACE, 'proj-1', 'src');
    });
  });
});

describe('FilesScreen — content, and the three ways it can be absent', () => {
  it('renders an EMPTY file as empty text, NOT as a refusal', async () => {
    // The collapse this exists to catch: "" and "withheld" both draw nothing
    // if the refusal branch is written as a falsiness check on `text`.
    render(
      <FilesScreen
        seam={seamWith(
          browseView({ entries: [FILE_ENTRY], totalEntries: 1 }),
          readView({ text: '', sizeBytes: 0 }),
        )}
        spaceId={SPACE}
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
          browseView({ entries: [MASKED_ENTRY], totalEntries: 1 }),
          readView({
            path: '.env', encoding: 'none', text: null,
            refusal: { reason: 'secret-pattern', detail: 'withheld by the secret-name policy' },
          }),
        )}
        spaceId={SPACE}
        projects={PROJECTS}
      />,
    );
    fireEvent.click(await screen.findByTestId('files-entry-.env'));
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
      ['outside-root', 'outside the project root'],
    ] as const) {
      const view = render(
        <FilesScreen
          seam={seamWith(
            browseView({ entries: [FILE_ENTRY], totalEntries: 1 }),
            readView({ encoding: 'none', text: null, refusal: { reason, detail: 'd' } }),
          )}
          spaceId={SPACE}
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
    // §4.4 — nothing off a project's disk gets a document context.
    render(
      <FilesScreen
        seam={seamWith(
          browseView({ entries: [FILE_ENTRY], totalEntries: 1 }),
          readView({ text: '<img src=x onerror="alert(1)">' }),
        )}
        spaceId={SPACE}
        projects={PROJECTS}
      />,
    );
    fireEvent.click(await screen.findByTestId('files-entry-README.md'));
    const pre = await screen.findByTestId('files-text');
    expect(pre.tagName).toBe('PRE');
    // The tag is TEXT in the pre, and no element was created from it.
    expect(pre.textContent).toContain('<img src=x');
    expect(pre.querySelector('img')).toBeNull();
  });
});
