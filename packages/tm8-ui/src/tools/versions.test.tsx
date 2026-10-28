// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EntityDetail, ToolRun } from '@tm8/contract';
import { fixtureDetails, sessionStale } from '../fixtures';
import { ToolBody } from './ToolBody';
import { createToolFixture, fixtureTool, fixtureVersion } from './fixture';
import { changedFields, resolveVersion, scalarChanges, versionHint, versionNote, type ToolVersionItem } from './versions-model';
import { diffSourceLines, sourceLines, unifiedSourceDiff } from './source-diff';

vi.mock('./SourceEditor', () => ({ SourceEditor: ({ value }: { value: string }) => <textarea aria-label="Source" value={value} readOnly /> }));
afterEach(cleanup);
const detail = { ...fixtureDetails[sessionStale.id]!, id: fixtureTool.id, version: fixtureTool.version, state: { kind: 'tool', name: fixtureTool.definition.name, runtime: 'bash', inputCount: 5, tm8Access: 'none' }, content: { kind: 'tool', definition: fixtureTool.definition } } as EntityDetail;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const launch = (port: ReturnType<typeof createToolFixture>['port'], expectedVersion: number, clientMutationId: string) =>
  port.run({ toolId: fixtureTool.id, expectedVersion, clientMutationId, keepOpen: false, inputs: { url: 'https://example.test' } });
const select = (group: HTMLElement, name: string) => within(group).getByRole('combobox', { name }) as HTMLSelectElement;
const rowsOf = (region: HTMLElement) => within(region).getAllByRole('row').slice(1);

describe('versions section', () => {
  it('lists stored versions newest first with who, when and what changed, and diffs the latest against the one before by default', async () => {
    const { port } = createToolFixture();
    await port.update(fixtureTool, { ...fixtureTool.definition, source: 'echo one\n' });
    await port.update(await port.get(fixtureTool.id), { ...fixtureTool.definition, source: 'echo two\n', description: 'Second' });
    render(<ToolBody detail={{ ...detail, version: 3 }} port={port} onOpenSession={vi.fn()} />);
    const region = await screen.findByRole('region', { name: 'Versions' });
    const rows = rowsOf(region);
    expect(rows.map(row => within(row).getAllByRole('cell').map(cell => cell.textContent?.trim()).slice(0, 2))).toEqual([['v3', 'Ada'], ['v2', 'Ada'], ['v1', 'Ada']]);
    expect(within(rows[0]!).getByText('description, source')).toBeTruthy();
    expect(within(rows[1]!).getByText('source')).toBeTruthy();
    expect(within(rows[2]!).getByText('created')).toBeTruthy();
    expect(within(rows[0]!).getByRole('time')).toBeTruthy();
    const compare = within(region).getByRole('group', { name: 'Source diff' });
    expect(select(compare, 'Compare from version').value).toBe('2');
    expect(select(compare, 'Compare to version').value).toBe('3');
    expect(compare.querySelector('.kit-diff__row--del')?.textContent).toContain('echo one');
    expect(compare.querySelector('.kit-diff__row--add')?.textContent).toContain('echo two');
    expect(within(compare).getByText('Also changed between v2 and v3: description.')).toBeTruthy();
    fireEvent.change(select(compare, 'Compare from version'), { target: { value: '1' } });
    await waitFor(() => expect(compare.querySelector('.kit-diff__row--del')?.textContent).toContain('curl --fail --head "$URL"'));
    expect(within(compare).queryByText(/Also changed/)).toBeTruthy();
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Compare v2 with v1' }));
    await waitFor(() => expect(select(compare, 'Compare to version').value).toBe('2'));
    expect(select(compare, 'Compare from version').value).toBe('1');
    expect(compare.querySelector('.kit-diff__row--add')?.textContent).toContain('echo one');
    expect(within(compare).queryByText(/Also changed/)).toBeNull();
  });
  it('opens a run’s stored version from the history, selecting it against the version before it', async () => {
    const fixture = createToolFixture(); const { port } = fixture;
    await port.update(fixtureTool, { ...fixtureTool.definition, source: 'echo one\n' });
    const { sessionId } = await launch(port, 2, 'at-two'); fixture.finish(sessionId, 'exited', 0);
    await port.update(await port.get(fixtureTool.id), { ...fixtureTool.definition, source: 'echo two\n' });
    render(<ToolBody detail={{ ...detail, version: 3 }} port={port} onOpenSession={vi.fn()} />);
    const history = await screen.findByRole('region', { name: 'Run history' });
    fireEvent.click(await within(history).findByRole('button', { name: 'v2' }));
    expect((await screen.findByText(/Showing v2, the version that run executed/)).textContent).toContain('aaaaaaaa');
    const compare = within(screen.getByRole('region', { name: 'Versions' })).getByRole('group', { name: 'Source diff' });
    await waitFor(() => expect(select(compare, 'Compare to version').value).toBe('2'));
    expect(select(compare, 'Compare from version').value).toBe('1');
    expect(compare.querySelector('.kit-diff__row--add')?.textContent).toContain('echo one');
  });
  it('refuses a folded version by name with the run’s source hash, and never offers it for a diff', async () => {
    const fixture = createToolFixture(); const { port } = fixture;
    await port.update(fixtureTool, { ...fixtureTool.definition, source: 'echo one\n' });
    const { sessionId } = await launch(port, 2, 'at-two'); fixture.finish(sessionId, 'exited', 0);
    fixture.fold();
    render(<ToolBody detail={{ ...detail, version: 3 }} port={port} onOpenSession={vi.fn()} />);
    const history = await screen.findByRole('region', { name: 'Run history' });
    expect(await within(history).findByText('folded into v3')).toBeTruthy();
    fireEvent.click(within(history).getByRole('button', { name: 'v2' }));
    const notice = await screen.findByText(/v2 was folded into v3; its source is not stored\./);
    expect(notice.textContent).toContain(`That run pinned source sha256 ${'a'.repeat(64)}`);
    const region = screen.getByRole('region', { name: 'Versions' });
    expect(rowsOf(region).map(row => within(row).getAllByRole('cell')[0]!.textContent)).toEqual(['v3', 'v1']);
    const compare = within(region).getByRole('group', { name: 'Source diff' });
    expect(within(compare).queryByRole('option', { name: 'v2' })).toBeNull();
    expect(within(region).getByText(/version numbers can skip/)).toBeTruthy();
  });
  it('says when a run’s version is newer than every stored snapshot', async () => {
    const fixture = createToolFixture(); const { port } = fixture;
    await port.update(fixtureTool, { ...fixtureTool.definition, source: 'echo one\n' });
    const { sessionId } = await launch(port, 2, 'at-two'); fixture.finish(sessionId, 'exited', 0);
    port.versions = vi.fn(async () => ({ items: [fixtureVersion(fixtureTool)], nextCursor: null }));
    render(<ToolBody detail={{ ...detail, version: 2 }} port={port} onOpenSession={vi.fn()} />);
    const history = await screen.findByRole('region', { name: 'Run history' });
    expect(await within(history).findByText('no stored snapshot')).toBeTruthy();
    fireEvent.click(within(history).getByRole('button', { name: 'v2' }));
    expect((await screen.findByText(/v2 has no stored snapshot\./)).textContent).toContain('a'.repeat(64));
  });
  it('resolves a run’s version lazily from one shared page set, never one versions call per row', async () => {
    const { port } = createToolFixture();
    const stored = (version: number) => fixtureVersion({ ...fixtureTool, version });
    const pages: Record<string, { items: ToolVersionItem[]; nextCursor: string | null }> = { first: { items: [stored(5), stored(4)], nextCursor: 'older' }, older: { items: [stored(2), stored(1)], nextCursor: null } };
    port.versions = vi.fn(async (_toolId: string, cursor?: string | null) => structuredClone(pages[cursor ?? 'first']!));
    const run = (n: number, toolVersion: number): ToolRun => ({ id: id(n), spaceId: fixtureTool.spaceId, toolId: fixtureTool.id, toolVersion, sourceSha256: 'b'.repeat(64), inputs: {}, state: 'exited', keepOpen: false, exitCode: 0, startedAt: '2026-10-10T12:00:00Z', exitedAt: '2026-10-10T12:00:01Z', outputTail: '', parentSessionId: null, invoker: null, triggeredBy: null });
    port.history = vi.fn(async () => ({ items: [run(13, 5), run(12, 3), run(11, 3)], nextCursor: null }));
    render(<ToolBody detail={{ ...detail, version: 5 }} port={port} onOpenSession={vi.fn()} />);
    const history = await screen.findByRole('region', { name: 'Run history' });
    await waitFor(() => expect(rowsOf(history)).toHaveLength(3));
    await screen.findByRole('region', { name: 'Versions' });
    await waitFor(() => expect(port.versions).toHaveBeenCalledTimes(1));
    expect(within(history).queryByText(/folded into/)).toBeNull();
    fireEvent.click(within(history).getAllByRole('button', { name: 'v3' })[0]!);
    expect((await screen.findByText(/v3 was folded into v4; its source is not stored\./)).textContent).toContain('b'.repeat(64));
    expect(port.versions).toHaveBeenCalledTimes(2);
    expect(port.versions).toHaveBeenLastCalledWith(fixtureTool.id, 'older');
    await waitFor(() => expect(within(history).getAllByText('folded into v4')).toHaveLength(2));
    expect(within(screen.getByRole('region', { name: 'Versions' })).getByRole('button', { name: 'More versions' })).toBeTruthy();
  });
});

describe('versions model', () => {
  const stored = (version: number, definition: Partial<typeof fixtureTool.definition> = {}, extra: Record<string, unknown> = {}): ToolVersionItem => {
    const item = fixtureVersion({ ...fixtureTool, version, definition: { ...fixtureTool.definition, ...definition } });
    return { ...item, snapshot: { ...item.snapshot, content: { ...(item.snapshot!['content'] as Record<string, unknown>), ...extra } } };
  };
  it('resolves a named version against stored, newest-first pages', () => {
    const items = [stored(5), stored(3)];
    expect(resolveVersion(5, items, false)).toMatchObject({ kind: 'stored' });
    expect(resolveVersion(4, items, false)).toEqual({ kind: 'folded', into: 5 });
    expect(resolveVersion(2, items, false)).toEqual({ kind: 'unknown' });
    expect(resolveVersion(2, items, true)).toEqual({ kind: 'folded', into: 3 });
    expect(resolveVersion(7, items, false)).toEqual({ kind: 'unstored' });
    expect(resolveVersion(1, [], false)).toEqual({ kind: 'unknown' });
    expect(resolveVersion(1, [], true)).toEqual({ kind: 'unstored' });
  });
  it('words a folded or unstored version for the notice and the table cell', () => {
    expect(versionHint(4, { kind: 'folded', into: 5 })).toBe('v4 was folded into v5; its source is not stored.');
    expect(versionHint(7, { kind: 'unstored' })).toBe('v7 has no stored snapshot.');
    expect(versionHint(5, { kind: 'stored', item: stored(5) })).toBeNull();
    expect(versionNote({ kind: 'folded', into: 5 })).toBe('folded into v5');
    expect(versionNote({ kind: 'unstored' })).toBe('no stored snapshot');
    expect(versionNote({ kind: 'unknown' })).toBeNull();
  });
  it('names the definition fields, config and secrets that changed between two snapshots', () => {
    const before = stored(1, {}, { config: { url: 'a' }, secretBindings: [] });
    const after = stored(2, { runtime: 'python', timeoutSeconds: 60, inputs: [] }, { config: { url: 'b' }, secretBindings: [{ inputName: 'token', credentialId: 'c1' }] });
    expect(changedFields(before, after)).toEqual(['runtime', 'inputs', 'timeout', 'config', 'secrets']);
    expect(scalarChanges(before, after)).toEqual(['runtime: bash → python', 'timeout: 900 → 60']);
    expect(changedFields(before, stored(2, {}, { config: { url: 'a' }, secretBindings: [] }))).toEqual([]);
    expect(changedFields(before, { ...before, snapshot: null })).toEqual(['name', 'description', 'runtime', 'source', 'inputs', 'help', 'tm8 access', 'timeout', 'config']);
  });
});

describe('source diff', () => {
  it('splits lines without inventing a trailing empty one', () => {
    expect(sourceLines('')).toEqual([]);
    expect(sourceLines('a\nb\n')).toEqual(['a', 'b']);
    expect(sourceLines('a\nb')).toEqual(['a', 'b']);
  });
  it('finds a shortest edit script and falls back to one replacement past the edit budget', () => {
    expect(diffSourceLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([{ kind: 'context', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'x' }, { kind: 'context', text: 'c' }]);
    expect(diffSourceLines(['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'e'])).toEqual([{ kind: 'context', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'context', text: 'c' }, { kind: 'context', text: 'd' }, { kind: 'add', text: 'e' }]);
    expect(diffSourceLines(['a', 'b', 'c'], ['a', 'x', 'y', 'c'], 1)).toEqual([{ kind: 'context', text: 'a' }, { kind: 'del', text: 'b' }, { kind: 'add', text: 'x' }, { kind: 'add', text: 'y' }, { kind: 'context', text: 'c' }]);
  });
  it('writes git-shaped unified hunks, empty when only the final newline differs', () => {
    expect(unifiedSourceDiff('a\nb\nc\n', 'a\nB\nc\n', { from: 't.sh', to: 't.sh' })).toBe('--- a/t.sh\n+++ b/t.sh\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
    expect(unifiedSourceDiff('', 'x\n', { from: 't.sh', to: 't.sh' })).toBe('--- a/t.sh\n+++ b/t.sh\n@@ -0,0 +1,1 @@\n+x\n');
    expect(unifiedSourceDiff('a\n', 'a', { from: 't.sh', to: 't.sh' })).toBe('');
    const long = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const edited = long.map(line => line === 'line 2' ? 'LINE 2' : line === 'line 17' ? 'LINE 17' : line);
    const text = unifiedSourceDiff(long.join('\n'), edited.join('\n'), { from: 't.sh', to: 't.sh' });
    expect(text.match(/^@@/gm)).toHaveLength(2);
    expect(text).toContain('@@ -1,6 +1,6 @@');
    expect(text).toContain('@@ -15,6 +15,6 @@');
  });
});
