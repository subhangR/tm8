import { describe, expect, it } from 'vitest';
import { fileBadgeText } from './FileTypeBadge';
import { filePaletteId, fileMatches, parseFilePaletteRef, recentFilePaletteViews } from './palette';
import { isProjectFilePath, toAbsolutePath, toRelativePath } from './paths';
import { mergeRecentPicks } from './recent';
import { formatBytes, viewerStateOf } from './viewerState';
import { readFailureMessage } from './ProjectFileViewer';

describe('viewerStateOf', () => {
  it('text: utf8 is source whatever the mime, cut off when truncated', () => {
    expect(viewerStateOf({ mime: 'video/mp2t', encoding: 'utf8', content: 'const a = 1;', truncated: false })).toEqual({
      kind: 'text', text: 'const a = 1;', cutAt: null,
    });
    expect(viewerStateOf({ mime: 'text/plain', encoding: 'utf8', content: 'abcd', truncated: true })).toEqual({
      kind: 'text', text: 'abcd', cutAt: 4,
    });
    expect(viewerStateOf({ mime: 'text/plain', encoding: 'utf8', content: 'héllo', truncated: false }, 2)).toEqual({
      kind: 'text', text: 'h', cutAt: 2,
    });
  });
  it('image: a raster from base64; a cut-off image is too large; SVG is never an image', () => {
    expect(viewerStateOf({ mime: 'image/png', encoding: 'base64', content: 'iVBO', truncated: false })).toEqual({
      kind: 'image', mime: 'image/png', base64: 'iVBO',
    });
    expect(viewerStateOf({ mime: 'image/png', encoding: 'base64', content: 'iVBO', truncated: true })).toEqual({ kind: 'tooLarge' });
    expect(viewerStateOf({ mime: 'image/svg+xml', encoding: 'base64', content: 'PHN2', truncated: false })).toEqual({ kind: 'binary' });
  });
  it('binary: anything else', () => {
    expect(viewerStateOf({ mime: 'application/octet-stream', encoding: 'base64', content: 'AAAA', truncated: false })).toEqual({ kind: 'binary' });
  });
  it('formats sizes plainly', () => {
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
  it('says why a read failed', () => {
    expect(readFailureMessage({ code: 'not_implemented' })).toMatch(/unavailable/);
    expect(readFailureMessage({ code: 'not_found' })).toMatch(/no longer/);
    expect(readFailureMessage(new Error('boom'))).toBe('Couldn’t read this file: boom');
  });
});

describe('paths', () => {
  it('joins and splits against the project root, POSIX and Windows', () => {
    expect(toAbsolutePath('/w/tm8', '/', 'src/a.ts')).toBe('/w/tm8/src/a.ts');
    expect(toAbsolutePath('C:\\w\\tm8\\', '\\', 'src/a.ts')).toBe('C:\\w\\tm8\\src\\a.ts');
    expect(toRelativePath('/w/tm8', '/', '/w/tm8/src/a.ts')).toBe('src/a.ts');
    expect(toRelativePath('C:\\w\\tm8', '\\', 'C:\\w\\tm8\\src\\a.ts')).toBe('src/a.ts');
    expect(toRelativePath('/w/tm8', '/', '/w/tm8-other/a.ts')).toBeNull();
    expect(toRelativePath('/w/tm8', '/', '/w/tm8')).toBeNull();
  });
  it('holds the contract rule', () => {
    expect(isProjectFilePath('src/a.ts')).toBe(true);
    for (const bad of ['', '/a', '../a', 'a/../b', 'a//b', 'C:\\a', 'a\u0000b']) expect(isProjectFilePath(bad)).toBe(false);
  });
});

describe('Recent and ⌘K sources', () => {
  it('merges entities and files newest first', () => {
    const entities = [
      { id: 'e1', activityAt: '2026-10-07T10:00:00.000Z' },
      { id: 'e2', activityAt: '2026-10-07T08:00:00.000Z' },
    ];
    const files = [{ projectId: 'p1', path: 'a.ts', openedAt: Date.parse('2026-10-07T09:00:00.000Z') }];
    expect(mergeRecentPicks(entities, files, 8).map((p) => p.type === 'file' ? p.file.path : p.id)).toEqual(['e1', 'a.ts', 'e2']);
    expect(mergeRecentPicks(entities, files, 2)).toHaveLength(2);
  });
  it('palette ids round-trip and filter by path or project name', () => {
    const target = { projectId: 'p:1', path: 'src/a b.ts' };
    const id = filePaletteId(target);
    const [scope, ref] = id.split(':', 2) as [string, string];
    expect(scope).toBe('file');
    expect(parseFilePaletteRef(ref)).toEqual(target);
    expect(parseFilePaletteRef(encodeURIComponent('p1\u0000../x'))).toBeNull();
    expect(fileMatches(target, 'tm8', 'A B')).toBe(true);
    expect(fileMatches(target, 'tm8', 'tm')).toBe(true);
    expect(fileMatches(target, 'tm8', 'zzz')).toBe(false);
    const views = recentFilePaletteViews([target], new Map([['p:1', 'tm8']]), 'zzz');
    expect(views).toEqual([]);
    expect(recentFilePaletteViews([target], new Map([['p:1', 'tm8']]))[0]?.label).toBe('a b.ts — tm8 · src/a b.ts');
  });
  it('badges by extension', () => {
    expect(fileBadgeText('src/a.ts')).toBe('TS');
    expect(fileBadgeText('x.json')).toBe('{}');
    expect(fileBadgeText('Makefile')).toBe('·');
  });
});
