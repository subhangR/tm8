// @vitest-environment jsdom
/**
 * The node-side folder picker, and the strip affordance that opens it.
 *
 * The assertion that matters most here is the LAST one in "attaches the exact
 * path the node returned": the picker must send back a path it was given, not
 * one it assembled. A browser that joins `workingDir` and a name is guessing at
 * another machine's filesystem, and the server would be right to refuse it.
 */
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityId, ProjectFileListing, ProjectId, ProjectResource } from '@tm8/contract';
import { describe, expect, it, vi } from 'vitest';

import { AttachmentStrip } from './AttachmentStrip';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import { attachmentsPortFromSeam, type ProjectFolderPort } from './port';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';

const ANCHOR = 'task-1' as EntityId;

const website: ProjectResource = {
  id: 'project-1' as ProjectId,
  name: 'Website',
  workingDir: '/srv/projects/website',
  trust: 'untrusted',
  defaults: {},
  createdAt: '2026-08-04T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
};

const api: ProjectResource = { ...website, id: 'project-2' as ProjectId, name: 'API' };

function listing(overrides: Partial<ProjectFileListing> = {}): ProjectFileListing {
  return {
    projectId: 'project-1',
    workingDir: '/srv/projects/website',
    path: '/srv/projects/website',
    parentPath: null,
    separator: '/',
    directories: [{ name: 'docs', path: '/srv/projects/website/docs' }],
    files: [
      {
        name: 'README.md',
        path: '/srv/projects/website/README.md',
        sizeBytes: 2_048,
        modifiedAt: '2026-08-04T00:00:00.000Z',
        mime: 'text/markdown',
        attachable: true,
      },
      {
        name: 'dump.bin',
        path: '/srv/projects/website/dump.bin',
        sizeBytes: 9_999_999,
        modifiedAt: '2026-08-04T00:00:00.000Z',
        mime: 'application/octet-stream',
        attachable: false,
      },
    ],
    truncated: false,
    maxSizeBytes: 1_048_576,
    ...overrides,
  };
}

function port(overrides: Partial<ProjectFolderPort> = {}): ProjectFolderPort {
  return {
    projects: vi.fn().mockResolvedValue([website]),
    list: vi.fn().mockResolvedValue(listing()),
    attach: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function picker(p: ProjectFolderPort, onAttached = vi.fn()) {
  return {
    onAttached,
    view: render(
      <ProjectFolderPicker port={p} anchorId={ANCHOR} onDismiss={vi.fn()} onAttached={onAttached} />,
    ),
  };
}

describe('the project folder picker', () => {
  it('opens the sole connected project without asking, and lists its folders and files', async () => {
    const p = port();
    const { view } = picker(p);

    await waitFor(() => expect(p.list).toHaveBeenCalledWith('project-1', undefined));
    expect(view.getByText('/srv/projects/website')).toBeTruthy();
    expect(view.getByText('docs')).toBeTruthy();
    expect(view.getByText('README.md')).toBeTruthy();
    // No project chooser is drawn for a list of one — it would be a control
    // with exactly one outcome.
    expect(view.queryByLabelText('Connected projects')).toBeNull();
  });

  it('offers a chooser when the Space has connected more than one project', async () => {
    const p = port({ projects: vi.fn().mockResolvedValue([website, api]) });
    const { view } = picker(p);

    await waitFor(() => expect(view.getByLabelText('Connected projects')).toBeTruthy());
    // Nothing is browsed until a project is chosen: there is no defensible default.
    expect(p.list).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: 'API' }));
    await waitFor(() => expect(p.list).toHaveBeenCalledWith('project-2', undefined));
  });

  it('attaches the exact path the node returned, against the anchor it was given', async () => {
    const p = port();
    const { view, onAttached } = picker(p);

    await waitFor(() => expect(view.getByText('README.md')).toBeTruthy());
    fireEvent.click(view.getByTitle('Attach README.md'));

    await waitFor(() => expect(onAttached).toHaveBeenCalled());
    expect(p.attach).toHaveBeenCalledWith({
      projectId: 'project-1',
      path: '/srv/projects/website/README.md',
      anchorId: ANCHOR,
    });
  });

  it('walks into a folder and back up, following only server-supplied paths', async () => {
    const p = port();
    p.list = vi.fn()
      .mockResolvedValueOnce(listing())
      .mockResolvedValue(listing({
        path: '/srv/projects/website/docs',
        parentPath: '/srv/projects/website',
        directories: [],
        files: [],
      }));
    const { view } = picker(p);

    await waitFor(() => expect(view.getByText('docs')).toBeTruthy());
    fireEvent.click(view.getByText('docs'));
    await waitFor(() => expect(p.list).toHaveBeenCalledWith('project-1', '/srv/projects/website/docs'));

    fireEvent.click(view.getByRole('button', { name: '↑ Parent' }));
    await waitFor(() => expect(p.list).toHaveBeenCalledWith('project-1', '/srv/projects/website'));
    expect(view.getByText('This folder is empty')).toBeTruthy();
  });

  it('shows a file it cannot store, disabled and with the reason — never hidden', async () => {
    const p = port();
    const { view } = picker(p);

    await waitFor(() => expect(view.getByText('dump.bin')).toBeTruthy());
    const row = view.getByTitle("Larger than this node's limit of 1 MB.");
    expect((row as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(row);
    expect(p.attach).not.toHaveBeenCalled();
  });

  it('keeps the picker open and states the reason when an attach is refused', async () => {
    const p = port({ attach: vi.fn().mockRejectedValue(new Error('file is outside the project working directory')) });
    const { view, onAttached } = picker(p);

    await waitFor(() => expect(view.getByText('README.md')).toBeTruthy());
    fireEvent.click(view.getByTitle('Attach README.md'));

    await waitFor(() =>
      expect(view.getByRole('alert').textContent).toBe('file is outside the project working directory'),
    );
    expect(onAttached).not.toHaveBeenCalled();
    expect(view.getByText('README.md')).toBeTruthy();
  });

  it('explains a Space with no connected folder rather than showing an empty browser', async () => {
    const p = port({ projects: vi.fn().mockResolvedValue([]) });
    const { view } = picker(p);

    await waitFor(() =>
      expect(view.getByText(/no connected project folder/)).toBeTruthy(),
    );
    expect(p.list).not.toHaveBeenCalled();
  });
});

describe('the strip affordance', () => {
  it('draws no folder control when the seam cannot read a filesystem', () => {
    const view = render(<AttachmentStrip anchorId={ANCHOR} files={[]} startUpload={vi.fn()} />);
    expect(view.queryByRole('button', { name: /project folder/ })).toBeNull();
  });

  it('opens the picker from the ＋ tile menu when the port is present', async () => {
    const p = port();
    const view = render(
      /* A file, because an idle strip draws no ＋ at all since 2026-08-18 —
         the tile this test is about only exists on a non-empty anchor. */
      <AttachmentStrip
        anchorId={ANCHOR}
        files={[
          {
            fileEntityId: 'f1' as never,
            name: 'notes.txt',
            mime: 'text/plain',
            sizeBytes: 12,
            attributedTo: { id: 'a', displayName: 'ada', isAgent: false, avatar: null },
            attributedAt: '2026-08-01T00:00:00.000Z',
            sourceMissing: false,
            edgeId: null,
          },
        ]}
        startUpload={vi.fn()}
        projectFolder={p}
      />,
    );

    // Both paths wired ⇒ ＋ opens the two-item menu; the folder item opens
    // the picker exactly as the old standing button did.
    fireEvent.click(view.getByTestId('attachment-add'));
    fireEvent.click(view.getByRole('menuitem', { name: /From a project folder/ }));
    await waitFor(() => expect(view.getByRole('dialog')).toBeTruthy());
    expect(p.projects).toHaveBeenCalled();
  });

  it('renders for an entity with nothing attached and no uploader, if the folder port is the only way in', () => {
    const view = render(<AttachmentStrip anchorId={ANCHOR} files={[]} projectFolder={port()} />);
    expect(view.getByTestId('attachment-strip')).toBeTruthy();
  });
});

describe('the seam adapter', () => {
  it('omits the folder port entirely against a seam with no filesystem', () => {
    // Driven against the REAL fixture seam, not a stub: the point is what a
    // fixture host actually gets, and a fixture seam has no node to read.
    const seam = createFixtureSeam();
    expect(attachmentsPortFromSeam(seam, 'space-1').projectFolder).toBeUndefined();
    expect(typeof attachmentsPortFromSeam(seam, 'space-1').startUpload).toBe('function');
  });

  it('carries the anchor into the attach as a target, with one mutation id per attempt', async () => {
    const attach = vi.fn().mockResolvedValue({ patches: [] });
    const seam = {
      ...createFixtureSeam(),
      projectFiles: { list: vi.fn(), attach },
    } as unknown as Parameters<typeof attachmentsPortFromSeam>[0];

    const folder = attachmentsPortFromSeam(seam, 'space-1').projectFolder!;
    await folder.attach({ projectId: 'project-1' as ProjectId, path: '/srv/a.md', anchorId: ANCHOR });
    await folder.attach({ projectId: 'project-1' as ProjectId, path: '/srv/a.md', anchorId: ANCHOR });

    expect(attach).toHaveBeenNthCalledWith(1, 'project-1', expect.objectContaining({
      spaceId: 'space-1',
      path: '/srv/a.md',
      targets: [ANCHOR],
    }));
    const ids = attach.mock.calls.map((call) => (call[1] as { clientMutationId: string }).clientMutationId);
    // A path-derived id would make the second attempt REPLAY the first rather
    // than record a second attach — and would fail outright once the file
    // changed on disk, because the ledger refuses a replay whose hash moved.
    expect(new Set(ids).size).toBe(2);
  });
});
