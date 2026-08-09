// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityId, ProjectId, ProjectResource, SpaceId, SpaceSummary } from '@tm8/contract';

import {
  NewSpaceProjectDialog,
  newOnboardingMutationIds,
  onboardSpaceProject,
  type ProjectOnboardingPort,
} from '../projects/NewSpaceProjectDialog';
import type { PackedArchive, ZipPacker } from './archive';
import { refusePath, treeFromDataTransfer, treeFromFileList } from './pick';
import { DEFAULT_ACTIVE_RULE_IDS, preflight, type PickedTree } from './preflight';
import { SpaceFolderStep, type SpaceFolderSelection } from './SpaceFolderStep';
import { readSpaceFoldersPort, type SpaceFolderSummary, type SpaceFoldersPort } from './port';

/* ------------------------------------------------------------------ fixtures */

const space: SpaceSummary = {
  id: 'space-1' as SpaceId,
  name: 'Studio',
  description: '',
  memberCount: 1,
  unreadTotal: 0,
  createdAt: '2026-08-09T00:00:00.000Z',
};

const project: ProjectResource = {
  id: 'project-1' as ProjectId,
  name: 'Website',
  workingDir: '/srv/projects/website',
  trust: 'untrusted',
  defaults: {},
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
};

/** A File whose `webkitRelativePath` is set, as a directory pick produces. */
function pickedFile(relativePath: string, body: string): File {
  const name = relativePath.split('/').pop()!;
  const file = new File([body], name);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

function treeOf(entries: readonly (readonly [string, string])[]): PickedTree {
  return treeFromFileList(entries.map(([path, body]) => pickedFile(path, body)));
}

const folderSummary: SpaceFolderSummary = {
  id: 'folder-1',
  spaceId: 'space-1',
  name: 'snapshot',
  entryCount: 2,
  totalSizeBytes: 20,
  createdBy: 'member-1',
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
};

function spaceFoldersPort(overrides: Partial<SpaceFoldersPort> = {}): SpaceFoldersPort {
  return {
    create: vi.fn().mockResolvedValue(folderSummary),
    upload: vi.fn().mockResolvedValue({
      folder: folderSummary,
      added: 2,
      replaced: 0,
      directories: 0,
      skipped: [],
    }),
    ...overrides,
  };
}

/**
 * Lane C owns the real encoder. This lane's saga only needs a Blob and the
 * refusal list, so the tests inject a fake packer — which is also the proof
 * that the packer really is injected and not hard-wired here.
 */
function fakePacker(overrides: Partial<PackedArchive> = {}): ZipPacker {
  return vi.fn(async (input) => ({
    blob: new Blob(['zip'], { type: 'application/zip' }),
    entries: input.files.length,
    directoryEntries: input.directories.length,
    bytes: input.files.reduce((sum, file) => sum + file.size, 0),
    skipped: [],
    ...overrides,
  }));
}

function onboardingPort(overrides: Partial<ProjectOnboardingPort> = {}): ProjectOnboardingPort {
  return {
    directories: vi.fn().mockResolvedValue({
      roots: ['/srv/projects'],
      path: '/srv/projects',
      parentPath: null,
      separator: '/',
      directories: [],
      truncated: false,
    }),
    createSpace: vi.fn().mockResolvedValue({
      space,
      memberId: 'member-1' as EntityId,
      defaultChannelId: 'channel-1' as EntityId,
    }),
    createProject: vi.fn().mockResolvedValue(project),
    linkProject: vi.fn().mockResolvedValue(undefined),
    createMemory: vi.fn().mockResolvedValue({ patches: [] }),
    ...overrides,
  };
}

/** Fake FileSystemEntry pair for a directory DROP. */
function fileEntry(name: string, body: string) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (file: File) => void) => ok(new File([body], name)),
  };
}

function directoryEntry(name: string, children: unknown[], batchSize = 100) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let cursor = 0;
      return {
        // Chromium returns at most 100 per call and signals the end with an
        // EMPTY batch. The fake reproduces that, so a reader that only calls
        // once is caught here rather than in production.
        readEntries(ok: (entries: unknown[]) => void) {
          const batch = children.slice(cursor, cursor + batchSize);
          cursor += batch.length;
          ok(batch);
        },
      };
    },
  };
}

/** Attaches an array to an <input type=file> the way a pick would. */
function choose(input: HTMLElement, files: readonly File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

/* ------------------------------------------------------- preflight honesty */

describe('folder pre-flight tells the truth about what will be sent', () => {
  it('counts included AND excluded in both files and bytes, naming every rule that fired', () => {
    const tree = treeOf([
      ['proj/src/app.ts', 'aaaa'],
      ['proj/README.md', 'bb'],
      ['proj/node_modules/left-pad/index.js', 'cccccccc'],
      ['proj/.git/HEAD', 'dddd'],
      ['proj/.DS_Store', 'e'],
    ]);

    const report = preflight(tree, DEFAULT_ACTIVE_RULE_IDS);

    expect(report.includedFiles).toBe(2);
    expect(report.includedBytes).toBe(6);
    expect(report.excludedFiles).toBe(3);
    expect(report.excludedBytes).toBe(13);
    expect(report.totalFiles).toBe(5);
    expect(report.totalBytes).toBe(19);
    // Every excluded byte is attributed to a NAMED rule; nothing disappears
    // into an unlabelled "other".
    expect(report.excludedGroups.map((group) => [group.ruleId, group.files, group.bytes])).toEqual([
      ['vcs', 1, 4],
      ['deps', 1, 8],
      ['os', 1, 1],
    ]);
    expect(report.excludedGroups.reduce((sum, group) => sum + group.bytes, 0)).toBe(report.excludedBytes);
  });

  it('is an override, not a filter: dropping a rule puts those bytes back', () => {
    const tree = treeOf([
      ['proj/src/app.ts', 'aaaa'],
      ['proj/node_modules/left-pad/index.js', 'cccccccc'],
    ]);

    const withDeps = preflight(tree, DEFAULT_ACTIVE_RULE_IDS.filter((id) => id !== 'deps'));

    expect(withDeps.includedFiles).toBe(2);
    expect(withDeps.includedBytes).toBe(12);
    expect(withDeps.excludedGroups).toEqual([]);
  });

  it('strips the local folder name so the tree is not nested under itself', () => {
    const tree = treeOf([['proj/src/app.ts', 'a']]);
    expect(tree.rootName).toBe('proj');
    expect(tree.files.map((file) => file.path)).toEqual(['src/app.ts']);
  });
});

/* -------------------------------------- paths refused rather than rewritten */

describe('unsafe relative paths are refused, never normalised', () => {
  it.each([
    ['../escape.txt', 'outside'],
    ['/etc/passwd', 'Absolute'],
    ['a//b.txt', 'Empty path segment'],
  ])('refuses %s', (path, fragment) => {
    expect(refusePath(path)).toContain(fragment);
  });

  it('accepts an ordinary nested path', () => {
    expect(refusePath('src/deep/app.ts')).toBeNull();
  });

  it('keeps a refused pick out of the files AND names it in the tree', () => {
    const escaped = pickedFile('proj/../../secrets.env', 'x');
    const tree = treeFromFileList([pickedFile('proj/src/app.ts', 'a'), escaped]);

    expect(tree.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(tree.refused).toHaveLength(1);
    expect(tree.refused[0]!.reason).toContain('outside the folder root');
  });
});

/* ------------------------------------------------- directory drop specifics */

describe('a directory DROP is a different mechanism from a folder pick', () => {
  it('walks webkitGetAsEntry recursively, because dataTransfer.files is empty for a folder', async () => {
    const root = directoryEntry('proj', [
      fileEntry('README.md', 'ab'),
      directoryEntry('src', [fileEntry('app.ts', 'cccc')]),
    ]);

    const tree = await treeFromDataTransfer({
      items: [{ webkitGetAsEntry: () => root as unknown as FileSystemEntry }],
      files: [],
    });

    expect(tree).not.toBeNull();
    expect(tree!.rootName).toBe('proj');
    expect(tree!.files.map((file) => file.path).sort()).toEqual(['README.md', 'src/app.ts']);
  });

  it('reads EVERY batch: a 130-child directory is not truncated at 100', async () => {
    const children = Array.from({ length: 130 }, (_, index) => fileEntry(`f${index}.txt`, 'x'));
    const root = directoryEntry('proj', children);

    const tree = await treeFromDataTransfer({
      items: [{ webkitGetAsEntry: () => root as unknown as FileSystemEntry }],
    });

    expect(tree!.files).toHaveLength(130);
  });

  it('preserves an empty directory, which a folder pick cannot even see', async () => {
    const root = directoryEntry('proj', [
      fileEntry('README.md', 'ab'),
      directoryEntry('logs', []),
    ]);

    const dropped = await treeFromDataTransfer({
      items: [{ webkitGetAsEntry: () => root as unknown as FileSystemEntry }],
    });
    const picked = treeOf([['proj/README.md', 'ab']]);

    expect(dropped!.emptyDirectories).toEqual(['logs']);
    expect(dropped!.emptyDirectoriesObservable).toBe(true);
    // The pick path reports NOT-KNOWN, not "none". A FileList cannot contain a
    // directory that holds no files, so "none found" there is not a measurement.
    expect(picked.emptyDirectories).toEqual([]);
    expect(picked.emptyDirectoriesObservable).toBe(false);
  });

  it('refuses a drop that carried no directory at all', async () => {
    const loose = fileEntry('a.txt', 'x');
    const tree = await treeFromDataTransfer({
      items: [{ webkitGetAsEntry: () => loose as unknown as FileSystemEntry }],
    });
    expect(tree).toBeNull();
  });
});

/* -------------------------------------------------------- archive boundary */

describe('the archive boundary is injected, not implemented here', () => {
  it('hands the packer the included files AND the empty directories', async () => {
    const pack = fakePacker();
    const folders = spaceFoldersPort();
    const tree = treeOf([['proj/src/app.ts', 'hello']]);
    const controller = new AbortController();
    const onPack = vi.fn();

    await onboardSpaceProject(
      onboardingPort({ spaceFolders: folders }),
      {
        spaceName: 'Studio',
        projectName: 'Website',
        workingDir: '/srv/projects/website',
        ensureWorkingDir: false,
        trusted: false,
        folder: { name: 'snapshot', files: tree.files, directories: ['logs'] },
      },
      newOnboardingMutationIds('pack'),
      undefined,
      { packArchive: pack, signal: controller.signal, onPack },
    );

    expect(pack).toHaveBeenCalledWith(
      { files: tree.files, directories: ['logs'] },
      { signal: controller.signal, onProgress: onPack },
    );
  });
});

/* --------------------------------------------------------- the saga itself */

describe('the folder step is optional and sequenced last', () => {
  const baseInput = {
    spaceName: 'Studio',
    projectName: 'Website',
    workingDir: '/srv/projects/website',
    ensureWorkingDir: false,
    trusted: false,
  };

  const withFolder = (files: PickedTree['files'], directories: readonly string[] = []) => ({
    ...baseInput,
    folder: { name: 'snapshot', files, directories },
  });

  it('runs EXACTLY the original four stages when no folder was picked', async () => {
    const stages: string[] = [];
    const folders = spaceFoldersPort();
    const p = onboardingPort({ spaceFolders: folders });

    const result = await onboardSpaceProject(
      p, baseInput, newOnboardingMutationIds('none'), (s) => stages.push(s), { packArchive: fakePacker() },
    );

    expect(stages).toEqual(['space', 'project', 'link', 'memory']);
    expect(folders.create).not.toHaveBeenCalled();
    expect(folders.upload).not.toHaveBeenCalled();
    expect(result.folder).toBeUndefined();
  });

  it('packs, creates and uploads AFTER the Space is complete, at the folder root', async () => {
    const stages: string[] = [];
    const folders = spaceFoldersPort();
    const p = onboardingPort({ spaceFolders: folders });
    const tree = treeOf([['proj/src/app.ts', 'hello']]);

    const result = await onboardSpaceProject(
      p, withFolder(tree.files), newOnboardingMutationIds('folder'), (s) => stages.push(s),
      { packArchive: fakePacker() },
    );

    // Packing precedes create: a cancelled pack must not leave an empty folder.
    expect(stages).toEqual(['space', 'project', 'link', 'memory', 'pack', 'folder', 'upload']);
    expect(folders.create).toHaveBeenCalledWith(space.id, 'snapshot');
    // destPath is the folder ROOT — repeating the name would nest it.
    expect(folders.upload).toHaveBeenCalledWith('folder-1', '', expect.any(Blob), expect.anything());
    expect(result.folder).toMatchObject({ added: 2, replaced: 0, directories: 0, skipped: [] });
    expect(result.folder!.folder.totalSizeBytes).toBe(20);
  });

  it('merges the packer\u2019s refusals with the server\u2019s skipped[] instead of picking one', async () => {
    const folders = spaceFoldersPort({
      upload: vi.fn().mockResolvedValue({
        folder: folderSummary,
        added: 1,
        replaced: 0,
        directories: 0,
        skipped: [{ path: 'src/huge.bin', reason: 'Rejected by the node.' }],
      }),
    });
    const p = onboardingPort({ spaceFolders: folders });
    const tree = treeOf([['proj/src/app.ts', 'hello']]);
    const pack = fakePacker({
      skipped: [{ path: 'src/very-long.txt', reason: 'Path too long for the archive.' }],
    });

    const result = await onboardSpaceProject(
      p, withFolder(tree.files), newOnboardingMutationIds('skip'), undefined, { packArchive: pack },
    );

    expect(result.folder!.skipped).toEqual([
      { path: 'src/very-long.txt', reason: 'Path too long for the archive.' },
      { path: 'src/huge.bin', reason: 'Rejected by the node.' },
    ]);
  });

  it('leaves the Space made when the upload fails, and fails at the upload stage', async () => {
    const folders = spaceFoldersPort({ upload: vi.fn().mockRejectedValue(new Error('node refused')) });
    const p = onboardingPort({ spaceFolders: folders });
    const tree = treeOf([['proj/src/app.ts', 'hello']]);

    await expect(onboardSpaceProject(
      p, withFolder(tree.files), newOnboardingMutationIds('fail'), undefined, { packArchive: fakePacker() },
    )).rejects.toMatchObject({ stage: 'upload' });

    // The four durable stages already ran. There is no spaces.delete on the
    // wire, so this is the only sequence that cannot strand the user.
    expect(p.createSpace).toHaveBeenCalledOnce();
    expect(p.linkProject).toHaveBeenCalledOnce();
    expect(p.createMemory).toHaveBeenCalledOnce();
  });

  it('reuses the folder a failed attempt already created, because create has no mutation id', async () => {
    const upload = vi.fn()
      .mockRejectedValueOnce(new Error('node refused'))
      .mockResolvedValueOnce({
        folder: folderSummary, added: 1, replaced: 0, directories: 0, skipped: [],
      });
    const folders = spaceFoldersPort({ upload });
    const p = onboardingPort({ spaceFolders: folders });
    const tree = treeOf([['proj/src/app.ts', 'hello']]);
    const ids = newOnboardingMutationIds('retry-folder');

    // The dialog retains what the first attempt created and hands it back.
    let retained: SpaceFolderSummary | null = null;
    const hooks = () => ({
      packArchive: fakePacker(),
      retainedFolder: retained,
      onFolderCreated: (folder: SpaceFolderSummary) => { retained = folder; },
    });

    await expect(onboardSpaceProject(p, withFolder(tree.files), ids, undefined, hooks()))
      .rejects.toMatchObject({ stage: 'upload' });
    const stages: string[] = [];
    await onboardSpaceProject(p, withFolder(tree.files), ids, (s) => stages.push(s), hooks());

    // ONE folder, TWO uploads. Replaying create would have made a second folder
    // with the same name and no way to tell them apart.
    expect(folders.create).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[1]![0]).toBe('folder-1');
    expect(stages).toEqual(['space', 'project', 'link', 'memory', 'pack', 'upload']);
  });

  it('does not create a folder when packing fails first', async () => {
    const folders = spaceFoldersPort();
    const p = onboardingPort({ spaceFolders: folders });
    const tree = treeOf([['proj/src/app.ts', 'hello']]);
    const pack = vi.fn().mockRejectedValue(new Error('Upload cancelled.'));

    await expect(onboardSpaceProject(
      p, withFolder(tree.files), newOnboardingMutationIds('cancel'), undefined, { packArchive: pack },
    )).rejects.toMatchObject({ stage: 'pack' });

    expect(folders.create).not.toHaveBeenCalled();
  });

  it('skips the folder stages when the node has no Space-folder storage', async () => {
    const stages: string[] = [];
    const p = onboardingPort();
    const tree = treeOf([['proj/src/app.ts', 'hello']]);

    await onboardSpaceProject(
      p, withFolder(tree.files), newOnboardingMutationIds('absent'), (s) => stages.push(s),
      { packArchive: fakePacker() },
    );

    expect(stages).toEqual(['space', 'project', 'link', 'memory']);
  });

  it('skips the folder stages when there is no packer to package with', async () => {
    const stages: string[] = [];
    const folders = spaceFoldersPort();
    const p = onboardingPort({ spaceFolders: folders });
    const tree = treeOf([['proj/src/app.ts', 'hello']]);

    await onboardSpaceProject(
      p, withFolder(tree.files), newOnboardingMutationIds('nopack'), (s) => stages.push(s),
    );

    expect(stages).toEqual(['space', 'project', 'link', 'memory']);
    expect(folders.create).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------- the step, rendered */

describe('the optional step renders honestly', () => {
  const renderStep = (props: Partial<React.ComponentProps<typeof SpaceFolderStep>> = {}) =>
    render(
      <SpaceFolderStep
        unavailableReason={null}
        disabled={false}
        onChange={() => {}}
        progress={null}
        outcome={null}
        {...props}
      />,
    );

  it('is off by default, so a user who only wants a Space is asked nothing', () => {
    const view = renderStep();
    const toggle = view.getByRole('checkbox', { name: /Also upload a folder/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(view.queryByLabelText('Choose a folder')).toBeNull();
  });

  it('renders disabled-with-reason when the node has no Space-folder storage', () => {
    const view = renderStep({ unavailableReason: 'No folder storage on this node.' });
    const toggle = view.getByRole('checkbox', { name: /Also upload a folder/ }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(view.getByText('No folder storage on this node.')).toBeTruthy();
  });

  it('shows counts and bytes for what will be sent and what was left out', () => {
    const view = renderStep();
    fireEvent.click(view.getByRole('checkbox', { name: /Also upload a folder/ }));
    choose(view.getByLabelText('Choose a folder'), [
      pickedFile('proj/src/app.ts', 'a'.repeat(2048)),
      pickedFile('proj/node_modules/x/index.js', 'b'.repeat(4096)),
    ]);

    expect(view.getByTestId('space-folder-included').textContent).toBe('1 file, 2.0 KB');
    expect(view.getByTestId('space-folder-excluded-total').textContent).toBe('1 file, 4.0 KB');
    expect(view.getByTestId('space-folder-excluded-deps').textContent).toContain('4.0 KB');
  });

  it('says a folder PICK cannot report empty folders rather than claiming there are none', () => {
    const view = renderStep();
    fireEvent.click(view.getByRole('checkbox', { name: /Also upload a folder/ }));
    choose(view.getByLabelText('Choose a folder'), [pickedFile('proj/src/app.ts', 'a')]);

    expect(view.getByTestId('space-folder-empty-dirs').textContent).toContain('Not knowable');
    expect(view.getByTestId('space-folder-empty-dirs').textContent).not.toContain('None in this folder');
  });

  it('publishes only the included files, and republishes when a rule is overridden', () => {
    const onChange = vi.fn();
    const view = renderStep({ onChange });
    fireEvent.click(view.getByRole('checkbox', { name: /Also upload a folder/ }));
    choose(view.getByLabelText('Choose a folder'), [
      pickedFile('proj/src/app.ts', 'a'),
      pickedFile('proj/node_modules/x/index.js', 'b'),
    ]);

    const first = onChange.mock.calls.at(-1)![0] as SpaceFolderSelection;
    expect(first.name).toBe('proj');
    expect(first.files.map((file) => file.path)).toEqual(['src/app.ts']);

    fireEvent.click(view.getByRole('checkbox', { name: /Installed dependencies/ }));
    const second = onChange.mock.calls.at(-1)![0] as SpaceFolderSelection;
    expect(second.files.map((file) => file.path)).toEqual(['src/app.ts', 'node_modules/x/index.js']);
  });

  it('names refused paths on screen instead of quietly dropping them', () => {
    const view = renderStep();
    fireEvent.click(view.getByRole('checkbox', { name: /Also upload a folder/ }));
    choose(view.getByLabelText('Choose a folder'), [
      pickedFile('proj/src/app.ts', 'a'),
      pickedFile('proj/../secrets.env', 'b'),
    ]);

    const refused = view.getByLabelText('Refused paths');
    expect(refused.textContent).toContain('secrets.env');
    expect(refused.textContent).toContain('outside the folder root');
  });

  it('renders bytes, counts and a cancel control while sending', () => {
    const onCancel = vi.fn();
    const view = renderStep({
      onCancel,
      progress: { phase: 'sending', packedFiles: 3, totalFiles: 3, sentBytes: 512, totalBytes: 2048 },
    });
    fireEvent.click(view.getByRole('checkbox', { name: /Also upload a folder/ }));

    expect(view.getByTestId('space-folder-progress').textContent).toContain('512 B of 2.0 KB');
    expect(view.getByTestId('space-folder-progress').textContent).toContain('3 files');
    fireEvent.click(view.getByRole('button', { name: 'Cancel upload' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('lists skipped[] rather than swallowing it', () => {
    const view = renderStep({
      outcome: {
        name: 'snapshot',
        added: 4,
        replaced: 0,
        directories: 1,
        entryCount: 4,
        totalSizeBytes: 100,
        skipped: [{ path: 'src/huge.bin', reason: 'Rejected by the node.' }],
      },
    });
    fireEvent.click(view.getByRole('checkbox', { name: /Also upload a folder/ }));

    expect(view.getByLabelText('Skipped files').textContent).toContain('src/huge.bin');
    expect(view.getByLabelText('Skipped files').textContent).toContain('Rejected by the node.');
  });
});

/* --------------------------------------------------- the step, in the dialog */

describe('the step is mounted in the Space-creation dialog', () => {
  const fillForm = (view: ReturnType<typeof render>) => {
    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    fireEvent.change(view.getByLabelText('Project name'), { target: { value: 'Website' } });
    fireEvent.click(view.getByRole('button', { name: 'Browse folders' }));
  };

  it('offers the step from the real Add Space dialog when the node supports it', () => {
    const view = render(
      <NewSpaceProjectDialog
        open
        nodeLabel="local node"
        port={onboardingPort({ spaceFolders: spaceFoldersPort() })}
        packArchive={fakePacker()}
        onDismiss={() => {}}
        onCreated={() => {}}
      />,
    );

    const toggle = view.getByRole('checkbox', { name: /Also upload a folder/ }) as HTMLInputElement;
    expect(toggle.disabled).toBe(false);
  });

  it('disables the step with a reason when Lane B\u2019s storage is absent', () => {
    const view = render(
      <NewSpaceProjectDialog
        open
        nodeLabel="local node"
        port={onboardingPort()}
        packArchive={fakePacker()}
        onDismiss={() => {}}
        onCreated={() => {}}
      />,
    );

    const toggle = view.getByRole('checkbox', { name: /Also upload a folder/ }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(view.getByText(/does not offer Space folder storage/)).toBeTruthy();
  });

  it('disables the step with a DIFFERENT reason when there is no packer', () => {
    const view = render(
      <NewSpaceProjectDialog
        open
        nodeLabel="local node"
        port={onboardingPort({ spaceFolders: spaceFoldersPort() })}
        onDismiss={() => {}}
        onCreated={() => {}}
      />,
    );

    const toggle = view.getByRole('checkbox', { name: /Also upload a folder/ }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    // Two different absences must not read as one. A node that HAS storage but
    // cannot package is a different fact from a node with no storage.
    expect(view.getByText(/cannot package a folder for upload yet/)).toBeTruthy();
  });

  it('holds the dialog open on a partial upload so the skipped files are not flashed past', async () => {
    const onCreated = vi.fn();
    const folders = spaceFoldersPort({
      upload: vi.fn().mockResolvedValue({
        folder: folderSummary,
        added: 1,
        replaced: 0,
        directories: 0,
        skipped: [{ path: 'src/huge.bin', reason: 'Rejected by the node.' }],
      }),
    });
    const view = render(
      <NewSpaceProjectDialog
        open
        nodeLabel="local node"
        port={onboardingPort({ spaceFolders: folders })}
        packArchive={fakePacker()}
        onDismiss={() => {}}
        onCreated={onCreated}
      />,
    );

    fillForm(view);
    await waitFor(() => view.getByRole('button', { name: 'Use this folder' }));
    fireEvent.click(view.getByRole('button', { name: 'Use this folder' }));
    fireEvent.click(view.getByRole('checkbox', { name: /Also upload a folder/ }));
    choose(view.getByLabelText('Choose a folder'), [pickedFile('proj/src/app.ts', 'hello')]);
    fireEvent.click(view.getByRole('button', { name: 'Create Space & add project' }));

    await waitFor(() => view.getByTestId('space-folder-outcome'));
    expect(view.getByLabelText('Skipped files').textContent).toContain('src/huge.bin');
    expect(onCreated).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: 'Open the Space' }));
    expect(onCreated).toHaveBeenCalledWith(space);
  });

  it('says the Space WAS created when only the upload failed', async () => {
    const folders = spaceFoldersPort({ upload: vi.fn().mockRejectedValue(new Error('node refused')) });
    const view = render(
      <NewSpaceProjectDialog
        open
        nodeLabel="local node"
        port={onboardingPort({ spaceFolders: folders })}
        packArchive={fakePacker()}
        onDismiss={() => {}}
        onCreated={() => {}}
      />,
    );

    fillForm(view);
    await waitFor(() => view.getByRole('button', { name: 'Use this folder' }));
    fireEvent.click(view.getByRole('button', { name: 'Use this folder' }));
    fireEvent.click(view.getByRole('checkbox', { name: /Also upload a folder/ }));
    choose(view.getByLabelText('Choose a folder'), [pickedFile('proj/src/app.ts', 'hello')]);
    fireEvent.click(view.getByRole('button', { name: 'Create Space & add project' }));

    const alert = await waitFor(() => view.getByText(/Uploading folder failed/));
    expect(alert.textContent).toContain('The Space and its project were created and are ready');
    // And it must say the folder EXISTS, or a user retries believing it does not.
    expect(alert.textContent).toContain('EXISTS and is empty or partial');
  });

  it('creates the Space with no folder stages at all when the step is left off', async () => {
    const onCreated = vi.fn();
    const folders = spaceFoldersPort();
    const view = render(
      <NewSpaceProjectDialog
        open
        nodeLabel="local node"
        port={onboardingPort({ spaceFolders: folders })}
        packArchive={fakePacker()}
        onDismiss={() => {}}
        onCreated={onCreated}
      />,
    );

    fillForm(view);
    await waitFor(() => view.getByRole('button', { name: 'Use this folder' }));
    fireEvent.click(view.getByRole('button', { name: 'Use this folder' }));
    fireEvent.click(view.getByRole('button', { name: 'Create Space & add project' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(space));
    expect(folders.create).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------ the seam read */

describe('the Space-folder seam group is read, not assumed', () => {
  it('is null at this base, because Lane B has not landed it', () => {
    expect(readSpaceFoldersPort({})).toBeNull();
    expect(readSpaceFoldersPort({ spaceFolders: { create: () => {} } })).toBeNull();
  });

  it('is adopted as soon as both operations are present', () => {
    const group = spaceFoldersPort();
    expect(readSpaceFoldersPort({ spaceFolders: group })).toBe(group);
  });
});
