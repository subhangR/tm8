// @vitest-environment jsdom
/**
 * Picker traversal + conflict preflight — pure logic, no component.
 */
import { describe, expect, it } from 'vitest';
import {
  filesFromDataTransfer,
  filesFromInput,
  findConflicts,
  keepBothName,
  refuseReason,
  resolveConflicts,
  type PickedFile,
} from './picker';

function fakeFile(name: string, relativePath?: string): File {
  const file = new File(['x'], name, { type: 'text/plain' });
  if (relativePath !== undefined) {
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  }
  return file;
}

describe('refuseReason — the boundary refusals', () => {
  it('passes ordinary relative paths', () => {
    expect(refuseReason('a.txt')).toBeNull();
    expect(refuseReason('folder/sub/a.txt')).toBeNull();
    expect(refuseReason('.hidden/file')).toBeNull();
  });
  it('refuses every hostile shape by name', () => {
    expect(refuseReason('../up.txt')).toMatch(/traversal/);
    expect(refuseReason('/abs.txt')).toMatch(/absolute/);
    expect(refuseReason('a\\b.txt')).toMatch(/backslash/);
    expect(refuseReason('a/\0b')).toMatch(/NUL/);
    expect(refuseReason('a//b')).toMatch(/empty or dot/);
    expect(refuseReason('a/./b')).toMatch(/empty or dot/);
    expect(refuseReason('')).toMatch(/empty/);
  });
});

describe('filesFromInput', () => {
  it('preserves webkitRelativePath when the browser filled it', () => {
    const list = {
      length: 2,
      item: () => null,
      0: fakeFile('a.txt', 'proj/src/a.txt'),
      1: fakeFile('b.txt'),
    } as unknown as FileList;
    Object.setPrototypeOf(list, Array.prototype);
    const result = filesFromInput(list);
    expect(result.files.map((f) => f.relativePath)).toEqual(['proj/src/a.txt', 'b.txt']);
    expect(result.refused).toEqual([]);
  });
  it('refuses a traversal path instead of carrying it', () => {
    const list = [fakeFile('up.txt', '../up.txt')] as unknown as FileList;
    const result = filesFromInput(list);
    expect(result.files).toEqual([]);
    expect(result.refused[0]?.reason).toMatch(/traversal/);
  });
});

describe('filesFromDataTransfer — directory walk', () => {
  interface FakeEntry {
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
    createReader?: () => { readEntries: (ok: (e: FakeEntry[]) => void, err: (e: unknown) => void) => void };
  }
  const fileEntry = (name: string): FakeEntry => ({
    isFile: true,
    isDirectory: false,
    name,
    file: (ok) => ok(fakeFile(name)),
  });
  function dirEntry(name: string, children: FakeEntry[], batchSize = 100): FakeEntry {
    let cursor = 0;
    return {
      isFile: false,
      isDirectory: true,
      name,
      createReader: () => ({
        readEntries: (ok) => {
          const batch = children.slice(cursor, cursor + batchSize);
          cursor += batch.length;
          ok(batch);
        },
      }),
    };
  }
  function transferOf(entries: FakeEntry[]): DataTransfer {
    return {
      items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })),
      files: [],
    } as unknown as DataTransfer;
  }

  it('walks a dropped directory and prefixes every relative path', async () => {
    const result = await filesFromDataTransfer(
      transferOf([dirEntry('root', [fileEntry('a.txt'), dirEntry('sub', [fileEntry('b.txt')])])]),
    );
    expect(result.files.map((f) => f.relativePath).sort()).toEqual([
      'root/a.txt',
      'root/sub/b.txt',
    ]);
  });

  it('drains readEntries past the 100-entry Chromium page — file 101 is not dropped', async () => {
    const children = Array.from({ length: 205 }, (_, i) => fileEntry(`f${i}.txt`));
    const result = await filesFromDataTransfer(transferOf([dirEntry('big', children)]));
    expect(result.files).toHaveLength(205);
  });

  it('falls back to the flat file list when webkitGetAsEntry is absent', async () => {
    const data = {
      items: [{}],
      files: [fakeFile('plain.txt')],
    } as unknown as DataTransfer;
    const result = await filesFromDataTransfer(data);
    expect(result.files.map((f) => f.relativePath)).toEqual(['plain.txt']);
  });
});

describe('conflict preflight — keep-both / replace / skip', () => {
  const picked: PickedFile[] = [
    { file: fakeFile('a.txt'), relativePath: 'a.txt' },
    { file: fakeFile('x'), relativePath: 'proj/x.txt' },
    { file: fakeFile('y'), relativePath: 'proj/y.txt' },
    { file: fakeFile('free.txt'), relativePath: 'free.txt' },
  ];
  const existing = new Set(['a.txt', 'proj']);

  it('finds conflicts by top segment', () => {
    expect(findConflicts(picked, existing).map((c) => c.existingName).sort()).toEqual([
      'a.txt',
      'proj',
      'proj',
    ]);
  });
  it('skip drops only the conflicted picks', () => {
    expect(resolveConflicts(picked, existing, 'skip').map((p) => p.relativePath)).toEqual([
      'free.txt',
    ]);
  });
  it('replace passes everything through unchanged', () => {
    expect(resolveConflicts(picked, existing, 'replace')).toHaveLength(4);
  });
  it('keep-both renames the top segment ONCE per collision, consistently', () => {
    const paths = resolveConflicts(picked, existing, 'keep-both').map((p) => p.relativePath);
    expect(paths).toContain('a (2).txt');
    expect(paths).toContain('proj (2)/x.txt');
    expect(paths).toContain('proj (2)/y.txt');
    expect(paths).toContain('free.txt');
  });
  it('keepBothName counts past taken candidates', () => {
    expect(keepBothName('a.txt', new Set(['a.txt', 'a (2).txt']))).toBe('a (3).txt');
    expect(keepBothName('folder', new Set(['folder']))).toBe('folder (2)');
    expect(keepBothName('.env', new Set(['.env']))).toBe('.env (2)');
  });
});
