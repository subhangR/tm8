// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { EntityDetail, ToolRun } from '@tm8/contract';
import { fixtureDetails, sessionStale } from '../fixtures';
import { ToolBody } from './ToolBody';
import { createToolFixture, fixtureTool, fixtureVersion } from './fixture';
import { changedFields, classifyVersions, resolveVersion, scalarChanges, sourceSha256Of, versionHint, versionNote, type ToolVersionItem } from './versions-model';
import { diffSourceLines, sourceLines, unifiedSourceDiff } from './source-diff';

vi.mock('./SourceEditor', () => ({ SourceEditor: ({ value }: { value: string }) => <textarea aria-label="Source" value={value} readOnly /> }));
afterEach(cleanup);
const detail = { ...fixtureDetails[sessionStale.id]!, id: fixtureTool.id, version: fixtureTool.version, state: { kind: 'tool', name: fixtureTool.definition.name, runtime: 'bash', inputCount: 5, tm8Access: 'none' }, content: { kind: 'tool', definition: fixtureTool.definition } } as EntityDetail;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Port = ReturnType<typeof createToolFixture>['port'];
const launch = (port: Port, expectedVersion: number, clientMutationId: string) =>
  port.run({ toolId: fixtureTool.id, expectedVersion, clientMutationId, keepOpen: false, inputs: { url: 'https://example.test' } });
const edit = async (port: Port, patch: Partial<typeof fixtureTool.definition>) => { const view = await port.get(fixtureTool.id); await port.update(view, { ...view.definition, ...patch }); };
const select = (group: HTMLElement, name: string) => within(group).getByRole('combobox', { name }) as HTMLSelectElement;
const rowsOf = (region: HTMLElement) => within(region).getAllByRole('row').slice(1);
const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map(cell => cell.textContent?.trim() ?? '');
/** A stored definition version, as 381 numbers them: execution version = entity version. */
const stored = (version: number, definition: Partial<typeof fixtureTool.definition> = {}, extra: Record<string, unknown> = {}): ToolVersionItem => {
  const item = fixtureVersion({ ...fixtureTool, version, executionVersion: version, definition: { ...fixtureTool.definition, ...definition } });
  return { ...item, snapshot: { ...item.snapshot, content: { ...(item.snapshot!['content'] as Record<string, unknown>), ...extra } } };
};

describe('versions section', () => {
  it('lists definition versions newest first with who, when and what changed, and diffs the two newest by default', async () => {
    const { port } = createToolFixture();
    await edit(port, { source: 'echo one\n' });
    await edit(port, { source: 'echo two\n', description: 'Second' });
    render(<ToolBody detail={{ ...detail, version: 3 }} port={port} onOpenSession={vi.fn()} />);
    const region = await screen.findByRole('region', { name: 'Versions' });
    const rows = rowsOf(region);
    expect(rows.map(row => cells(row).slice(0, 2))).toEqual([[`v3 ${sourceSha256Of('echo two\n').slice(0, 8)}`, 'Ada'], [`v2 ${sourceSha256Of('echo one\n').slice(0, 8)}`, 'Ada'], [`v1 ${sourceSha256Of(fixtureTool.definition.source).slice(0, 8)}`, 'Ada']]);
    expect(rows.map(row => cells(row)[3])).toEqual(['source, description', 'source', 'created']);
    expect(within(rows[0]!).getByRole('time')).toBeTruthy();
    expect(within(region).queryByText(/hidden/)).toBeNull();
    const compare = within(region).getByRole('group', { name: 'Source diff' });
    expect(select(compare, 'Compare from version').value).toBe('2');
    expect(select(compare, 'Compare to version').value).toBe('3');
    expect(compare.querySelector('.kit-diff__row--del')?.textContent).toContain('echo one');
    expect(compare.querySelector('.kit-diff__row--add')?.textContent).toContain('echo two');
    expect(within(compare).getByText('Also changed between v2 and v3: description.')).toBeTruthy();
    fireEvent.change(select(compare, 'Compare from version'), { target: { value: '1' } });
    await waitFor(() => expect(compare.querySelector('.kit-diff__row--del')?.textContent).toContain('curl --fail --head "$URL"'));
    fireEvent.click(within(rows[1]!).getByRole('button', { name: 'Compare v2 with v1' }));
    await waitFor(() => expect(select(compare, 'Compare to version').value).toBe('2'));
    expect(select(compare, 'Compare from version').value).toBe('1');
    expect(compare.querySelector('.kit-diff__row--add')?.textContent).toContain('echo one');
    expect(within(compare).queryByText(/Also changed/)).toBeNull();
  });
  it('hides help, config and secret writes until all writes are shown, labelling each by what changed', async () => {
    const { port } = createToolFixture();
    await edit(port, { source: 'echo one\n' });
    await port.setConfig(await port.get(fixtureTool.id), 'limit', 7);
    await edit(port, { help: 'Run it.' });
    await port.setSecret(await port.get(fixtureTool.id), 'token', 'private-token-abcd');
    render(<ToolBody detail={{ ...detail, version: 5 }} port={port} onOpenSession={vi.fn()} />);
    const region = await screen.findByRole('region', { name: 'Versions' });
    expect(rowsOf(region).map(row => row.getAttribute('data-version'))).toEqual(['2', '1']);
    // Between two definition versions the Changed cell spans the writes hidden between them.
    expect(cells(rowsOf(region)[0]!)[3]).toBe('source');
    expect(screen.getByText('Version 2')).toBeTruthy();
    const toggle = within(region).getByRole('checkbox', { name: 'Show all writes (3 hidden)' });
    fireEvent.click(toggle);
    const rows = rowsOf(region);
    expect(rows.map(row => row.getAttribute('data-version'))).toEqual(['5', '4', '3', '2', '1']);
    expect(rows.map(row => cells(row)[0])).toEqual(['v2 · secrets', 'v2 · help', 'v2 · config', `v2 ${sourceSha256Of('echo one\n').slice(0, 8)}`, `v1 ${sourceSha256Of(fixtureTool.definition.source).slice(0, 8)}`]);
    expect(rows.map(row => cells(row)[3])).toEqual(['secrets', 'help', 'config', 'source', 'created']);
    expect(rows.map(row => row.getAttribute('data-definition'))).toEqual([null, null, null, 'true', 'true']);
    const compare = within(region).getByRole('group', { name: 'Source diff' });
    expect(within(compare).getAllByRole('option').map(option => option.textContent)).toEqual(['v2', 'v1', 'v2', 'v1']);
    expect(document.body.textContent).not.toContain('private-token-abcd');
  });
  it('opens a run’s stored version from the history, selecting it against the definition version before it', async () => {
    const fixture = createToolFixture(); const { port } = fixture;
    await edit(port, { source: 'echo one\n' });
    const { sessionId } = await launch(port, 2, 'at-two'); fixture.finish(sessionId, 'exited', 0);
    await edit(port, { source: 'echo two\n' });
    render(<ToolBody detail={{ ...detail, version: 3 }} port={port} onOpenSession={vi.fn()} />);
    const history = await screen.findByRole('region', { name: 'Run history' });
    fireEvent.click(await within(history).findByRole('button', { name: 'v2' }));
    expect((await screen.findByText(/Showing v2, the version that run executed/)).textContent).toContain('aaaaaaaa');
    const compare = within(screen.getByRole('region', { name: 'Versions' })).getByRole('group', { name: 'Source diff' });
    await waitFor(() => expect(select(compare, 'Compare to version').value).toBe('2'));
    expect(select(compare, 'Compare from version').value).toBe('1');
    expect(compare.querySelector('.kit-diff__row--add')?.textContent).toContain('echo one');
  });
  it('shows a pre-381 run that pinned a configuration write as the definition version it ran', async () => {
    const { port } = createToolFixture();
    await edit(port, { source: 'echo one\n' });
    await port.setConfig(await port.get(fixtureTool.id), 'limit', 7);
    const run: ToolRun = { id: id(11), spaceId: fixtureTool.spaceId, toolId: fixtureTool.id, toolVersion: 3, sourceSha256: sourceSha256Of('echo one\n'), inputs: {}, state: 'exited', keepOpen: false, exitCode: 0, startedAt: '2026-10-10T12:00:00Z', exitedAt: '2026-10-10T12:00:01Z', outputTail: '', parentSessionId: null, invoker: null, triggeredBy: null };
    port.history = vi.fn(async () => ({ items: [run], nextCursor: null }));
    render(<ToolBody detail={{ ...detail, version: 3 }} port={port} onOpenSession={vi.fn()} />);
    const history = await screen.findByRole('region', { name: 'Run history' });
    fireEvent.click(await within(history).findByRole('button', { name: 'v3' }));
    expect((await screen.findByText(/Showing v2, the version that run executed/)).textContent).toContain(sourceSha256Of('echo one\n').slice(0, 8));
    expect(within(history).queryByText('source unavailable')).toBeNull();
  });
  it('refuses a folded version by name with the run’s source hash, and never offers it for a diff', async () => {
    const fixture = createToolFixture(); const { port } = fixture;
    await edit(port, { source: 'echo one\n' });
    const { sessionId } = await launch(port, 2, 'at-two'); fixture.finish(sessionId, 'exited', 0);
    fixture.fold();
    render(<ToolBody detail={{ ...detail, version: 3 }} port={port} onOpenSession={vi.fn()} />);
    const history = await screen.findByRole('region', { name: 'Run history' });
    expect(await within(history).findByText('source unavailable')).toBeTruthy();
    fireEvent.click(within(history).getByRole('button', { name: 'v2' }));
    const notice = await screen.findByText(/Source unavailable: v2 was folded into v3/);
    expect(notice.textContent).toContain(`That run pinned source sha256 ${'a'.repeat(64)}`);
    const region = screen.getByRole('region', { name: 'Versions' });
    expect(rowsOf(region).map(row => row.getAttribute('data-version'))).toEqual(['3', '1']);
    const compare = within(region).getByRole('group', { name: 'Source diff' });
    expect(within(compare).queryByRole('option', { name: 'v2' })).toBeNull();
  });
  it('says when a run’s version is newer than every stored snapshot', async () => {
    const fixture = createToolFixture(); const { port } = fixture;
    await edit(port, { source: 'echo one\n' });
    const { sessionId } = await launch(port, 2, 'at-two'); fixture.finish(sessionId, 'exited', 0);
    port.versions = vi.fn(async () => ({ items: [fixtureVersion(fixtureTool)], nextCursor: null }));
    render(<ToolBody detail={{ ...detail, version: 2 }} port={port} onOpenSession={vi.fn()} />);
    const history = await screen.findByRole('region', { name: 'Run history' });
    expect(await within(history).findByText('source unavailable')).toBeTruthy();
    fireEvent.click(within(history).getByRole('button', { name: 'v2' }));
    expect((await screen.findByText(/Source unavailable: v2 has no stored snapshot\./)).textContent).toContain('a'.repeat(64));
  });
  it('resolves a run’s version lazily from one shared page set, never one versions call per row', async () => {
    const { port } = createToolFixture();
    const pages: Record<string, { items: ToolVersionItem[]; nextCursor: string | null }> = { first: { items: [stored(5), stored(4)], nextCursor: 'older' }, older: { items: [stored(2), stored(1)], nextCursor: null } };
    port.versions = vi.fn(async (_toolId: string, cursor?: string | null) => structuredClone(pages[cursor ?? 'first']!));
    const run = (n: number, toolVersion: number): ToolRun => ({ id: id(n), spaceId: fixtureTool.spaceId, toolId: fixtureTool.id, toolVersion, sourceSha256: 'b'.repeat(64), inputs: {}, state: 'exited', keepOpen: false, exitCode: 0, startedAt: '2026-10-10T12:00:00Z', exitedAt: '2026-10-10T12:00:01Z', outputTail: '', parentSessionId: null, invoker: null, triggeredBy: null });
    port.history = vi.fn(async () => ({ items: [run(13, 5), run(12, 3), run(11, 3)], nextCursor: null }));
    render(<ToolBody detail={{ ...detail, version: 5 }} port={port} onOpenSession={vi.fn()} />);
    const history = await screen.findByRole('region', { name: 'Run history' });
    await waitFor(() => expect(rowsOf(history)).toHaveLength(3));
    await screen.findByRole('region', { name: 'Versions' });
    await waitFor(() => expect(port.versions).toHaveBeenCalledTimes(1));
    expect(within(history).queryByText('source unavailable')).toBeNull();
    fireEvent.click(within(history).getAllByRole('button', { name: 'v3' })[0]!);
    expect((await screen.findByText(/Source unavailable: v3 was folded into v4/)).textContent).toContain('b'.repeat(64));
    expect(port.versions).toHaveBeenCalledTimes(2);
    expect(port.versions).toHaveBeenLastCalledWith(fixtureTool.id, 'older');
    await waitFor(() => expect(within(history).getAllByText('source unavailable')).toHaveLength(2));
    expect(within(screen.getByRole('region', { name: 'Versions' })).queryByRole('button', { name: 'More versions' })).toBeNull();
  });
});

describe('versions model', () => {
  it('classifies rows as the CLI does: definition when the execution version is its own, with the pre-381 fallback', () => {
    // 381 rows, each cumulative on the one before: v5 config (runs as v4), v4 source edit, v3 help edit (runs as v1), v2 config, v1 create.
    const items = [
      stored(5, { help: 'Run it.', source: 'echo two\n' }, { execution_version: 4, config: { limit: 9 } }),
      stored(4, { help: 'Run it.', source: 'echo two\n' }, { config: { limit: 7 } }),
      stored(3, { help: 'Run it.' }, { execution_version: 1, config: { limit: 7 } }),
      stored(2, {}, { execution_version: 1, config: { limit: 7 } }),
      stored(1),
    ];
    const rows = classifyVersions(items, true);
    expect(rows.map(row => [row.version, row.executionVersion, row.definition, row.changed])).toEqual([
      [5, 4, false, ['config']], [4, 4, true, ['source']], [3, 1, false, ['help']], [2, 1, false, ['config']], [1, 1, true, []],
    ]);
    expect(rows[1]!.sourceSha256).toBe(sourceSha256Of('echo two\n'));
    // Pre-381 numbering: execution_version counted on its own, so a source edit at v3 carries execution_version 2.
    const older = [stored(3, { source: 'echo one\n' }, { execution_version: 2, config: { limit: 7 } }), stored(2, {}, { execution_version: 1, config: { limit: 7 } }), stored(1)];
    expect(classifyVersions(older, true).map(row => [row.version, row.executionVersion, row.definition])).toEqual([[3, 3, true], [2, 1, false], [1, 1, true]]);
    // The oldest loaded row of an incomplete list stays visible until the page behind it loads.
    const partial = classifyVersions([stored(5, {}, { execution_version: 4, config: { limit: 9 } })], false);
    expect(partial[0]).toMatchObject({ definition: true, changed: null });
  });
  it('resolves a named version against stored, newest-first rows', () => {
    const rows = classifyVersions([stored(5), stored(3)], false);
    expect(resolveVersion(5, rows, false)).toMatchObject({ kind: 'stored', row: { version: 5 } });
    expect(resolveVersion(4, rows, false)).toEqual({ kind: 'folded', into: 5 });
    expect(resolveVersion(2, rows, false)).toEqual({ kind: 'unknown' });
    expect(resolveVersion(2, rows, true)).toEqual({ kind: 'folded', into: 3 });
    expect(resolveVersion(7, rows, false)).toEqual({ kind: 'unstored' });
    expect(resolveVersion(1, [], false)).toEqual({ kind: 'unknown' });
    expect(resolveVersion(1, [], true)).toEqual({ kind: 'unstored' });
  });
  it('words an unavailable source for the notice and the table cell', () => {
    expect(versionHint(4, { kind: 'folded', into: 5 })).toBe('Source unavailable: v4 was folded into v5 before every write kept its own snapshot.');
    expect(versionHint(7, { kind: 'unstored' })).toBe('Source unavailable: v7 has no stored snapshot.');
    expect(versionHint(5, { kind: 'stored', row: classifyVersions([stored(5)], true)[0]! })).toBeNull();
    expect(versionNote({ kind: 'folded', into: 5 })).toBe('source unavailable');
    expect(versionNote({ kind: 'unstored' })).toBe('source unavailable');
    expect(versionNote({ kind: 'unknown' })).toBeNull();
  });
  it('names the definition fields, config and secrets that changed between two snapshots', () => {
    const before = stored(1, {}, { config: { url: 'a' }, secretBindings: [] });
    const after = stored(2, { runtime: 'python', timeoutSeconds: 60, inputs: [] }, { config: { url: 'b' }, secretBindings: [{ inputName: 'token', credentialId: 'c1' }] });
    expect(changedFields(before, after)).toEqual(['runtime', 'inputs', 'timeoutSeconds', 'config', 'secrets']);
    expect(scalarChanges(before, after)).toEqual(['runtime: bash → python', 'timeout: 900 → 60']);
    expect(changedFields(before, stored(2, {}, { config: { url: 'a' }, secretBindings: [] }))).toEqual([]);
    expect(changedFields(before, { ...before, snapshot: null })).toEqual(['source', 'runtime', 'inputs', 'tm8Access', 'timeoutSeconds', 'name', 'description', 'help', 'config']);
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
  it('hashes a source the way the server pins it', () => {
    expect(sourceSha256Of('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
