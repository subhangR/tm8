// @vitest-environment jsdom
/**
 * The folder-import task over a controllable seam surface — asserting on the
 * WIRE SHAPES the real `projects.folderUploads.*` lifecycle receives, and on
 * outcomes a screen renders. The fake is TYPED as the seam group, so a drift
 * in the contract DTOs fails here at compile time.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  ProjectFolderUploadGrant,
  ProjectFolderUploadInitInput,
  ProjectFolderUploadResult,
} from '@tm8/contract';
import { UploadCancelledError } from '../files/upload';
import { directoryEntries, startFolderImport } from './folder-import';

const SPACE = 'space-1' as never;

function pick(relativePath: string, bytes = 'x'): { file: File; relativePath: string } {
  return { file: new File(bytes.length > 0 ? [bytes] : [], relativePath.split('/').pop()!), relativePath };
}

function grantFor(init: ProjectFolderUploadInitInput): ProjectFolderUploadGrant {
  return {
    folderUploadId: 'fu-1',
    expiresAt: '2026-08-10T01:00:00Z',
    maxFiles: 1000,
    maxDirectories: 2000,
    maxTotalBytes: 1024 ** 3,
    maxPathBytes: 1024,
    // Zero-byte files receive NO grant — the wire's own rule.
    files: init.entries
      .filter((e) => e.kind === 'file' && e.sizeBytes > 0)
      .map((e) => ({
        uploadId: `u:${e.relativePath}`,
        uploadUrl: `/put/${e.relativePath}`,
        expiresAt: '2026-08-10T01:00:00Z',
        maxSizeBytes: 1024 ** 2,
        relativePath: e.relativePath,
      })),
  };
}

function resultFor(replacedCount = 0): ProjectFolderUploadResult {
  return {
    folderUploadId: 'fu-1',
    spaceId: SPACE,
    project: { id: 'p-new', name: 'proj' } as never,
    rootName: 'proj',
    fileCount: 3,
    directoryCount: 1,
    totalBytes: 3,
    replacedCount,
  } as ProjectFolderUploadResult;
}

function harness(opts?: {
  conflictOnCreate?: boolean;
  holdPuts?: boolean;
}) {
  const initCalls: ProjectFolderUploadInitInput[] = [];
  const putPaths: string[] = [];
  const abort = vi.fn(async () => {});
  const complete = vi.fn(async () => resultFor(opts?.conflictOnCreate ? 2 : 0));
  let releasePuts: () => void = () => {};
  const putGate = new Promise<void>((r) => {
    releasePuts = r;
  });
  const deps = {
    folderUploads: {
      init: vi.fn(async (_space: never, input: ProjectFolderUploadInitInput) => {
        initCalls.push(input);
        if (opts?.conflictOnCreate && (input.mode ?? 'create') === 'create') {
          throw Object.assign(new Error('destination exists'), { code: 'conflict' });
        }
        return grantFor(input);
      }),
      complete,
      abort,
    },
    putBytes: vi.fn(async (grant: { relativePath?: string }) => {
      putPaths.push(grant.relativePath!);
      if (opts?.holdPuts) await putGate;
    }),
    directories: vi.fn(async () => ({
      roots: ['/srv/projects'],
      path: '/srv/projects',
      parentPath: null,
      separator: '/' as const,
      directories: [],
      truncated: false,
    })),
    spaceId: SPACE,
    checksum: async () => 'a'.repeat(64),
  };
  return { deps: deps as never as Parameters<typeof startFolderImport>[0], initCalls, putPaths, abort, complete, releasePuts };
}

describe('directoryEntries', () => {
  it('derives every proper prefix once, sorted', () => {
    expect(directoryEntries(['a/b/c.txt', 'a/b/d.txt', 'a/e.txt'])).toEqual(['a', 'a/b']);
    expect(directoryEntries(['flat.txt'])).toEqual([]);
  });
});

describe('startFolderImport', () => {
  it('freezes a manifest with directories + files and PUTs only granted (non-empty) files', async () => {
    const { deps, initCalls, putPaths } = harness();
    const task = startFolderImport(deps, [pick('proj/a.txt'), pick('proj/sub/b.txt'), pick('proj/empty.txt', '')], 'proj');
    const outcome = await task.result;
    const init = initCalls[0]!;
    expect(init.rootName).toBe('proj');
    expect(init.destinationParent).toBe('/srv/projects');
    expect(init.entries.filter((e) => e.kind === 'directory').map((e) => e.relativePath)).toEqual([
      'proj',
      'proj/sub',
    ]);
    expect(init.entries.filter((e) => e.kind === 'file')).toHaveLength(3);
    // the zero-byte file got no grant and therefore no PUT — and that is fine
    expect(putPaths.sort()).toEqual(['proj/a.txt', 'proj/sub/b.txt']);
    expect(outcome.merged).toBe(false);
    expect(outcome.replacedCount).toBe(0);
  });

  it('R8: a `conflict` on create retries ONCE with mode merge and reports replacedCount', async () => {
    const { deps, initCalls } = harness({ conflictOnCreate: true });
    const outcome = await startFolderImport(deps, [pick('proj/a.txt')], 'proj').result;
    expect(initCalls.map((i) => i.mode ?? 'create')).toEqual(['create', 'merge']);
    expect(outcome.merged).toBe(true);
    expect(outcome.replacedCount).toBe(2);
  });

  it('cancel mid-flight ABORTS the server session and rejects with the cancel error', async () => {
    const { deps, abort, complete, releasePuts } = harness({ holdPuts: true });
    const task = startFolderImport(
      deps,
      [pick('proj/a.txt'), pick('proj/b.txt'), pick('proj/c.txt'), pick('proj/d.txt')],
      'proj',
    );
    // let init + first PUTs begin
    await new Promise((r) => setTimeout(r, 0));
    task.cancel();
    // In-flight PUTs cannot be torn out of the air (a fetch has no handle
    // here); cancellation lands at the next lifecycle checkpoint once they
    // settle — same semantics as files/upload.ts.
    releasePuts();
    await expect(task.result).rejects.toBeInstanceOf(UploadCancelledError);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('bounds PUT concurrency at 3', async () => {
    const { deps, putPaths, releasePuts } = harness({ holdPuts: true });
    const task = startFolderImport(
      deps,
      Array.from({ length: 6 }, (_, i) => pick(`proj/f${i}.txt`)),
      'proj',
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(putPaths).toHaveLength(3);
    releasePuts();
    await task.result;
    expect(putPaths).toHaveLength(6);
  });

  it('an authorize refusal fires BEFORE destination discovery and before init — nothing leaks', async () => {
    const { deps } = harness();
    const d = deps as never as {
      authorize?: () => Promise<void>;
      directories: ReturnType<typeof vi.fn>;
      folderUploads: { init: ReturnType<typeof vi.fn> };
    };
    d.authorize = async () => {
      throw Object.assign(new Error('node-admin only'), { code: 'forbidden' });
    };
    const task = startFolderImport(deps, [pick('proj/a.txt')], 'proj');
    await expect(task.result).rejects.toMatchObject({ code: 'forbidden' });
    expect(d.directories).not.toHaveBeenCalled();
    expect(d.folderUploads.init).not.toHaveBeenCalled();
  });

  it('a PUT failure aborts the session and surfaces the error', async () => {
    const { deps, abort } = harness();
    (deps as never as { putBytes: () => Promise<void> }).putBytes = async () => {
      throw Object.assign(new Error('nope'), { code: 'payload_too_large' });
    };
    const task = startFolderImport(deps, [pick('proj/a.txt')], 'proj');
    await expect(task.result).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
