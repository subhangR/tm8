import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffView } from '../kit/DiffView';
import { Timestamp } from '../kit/Timestamp';
import type { ToolPort } from './port';
import { ToolErrorAlert, toolErrorOf, type ToolErrorView } from './errors';
import { shortSha } from './values';
import { unifiedSourceDiff } from './source-diff';
import {
  changedFields, resolveVersion, scalarChanges, snapshotDefinition, snapshotSource, versionHint,
  type ToolVersionItem, type VersionResolution,
} from './versions-model';

/** Bounds the walk a run's version may trigger: 50 pages of 20 is a thousand stored versions. */
const MAX_ENSURE_PAGES = 50;
interface Loaded { items: ToolVersionItem[]; cursor: string | null; loaded: boolean }

/** Stored versions, newest first. One page loads with the page; more only on request. */
export function useToolVersions(port: ToolPort | undefined, toolId: string, refreshKey: unknown) {
  const [state, setState] = useState<Loaded>({ items: [], cursor: null, loaded: false });
  const [error, setError] = useState<ToolErrorView | null>(null);
  const [loading, setLoading] = useState(false);
  const current = useRef(state);
  current.current = state;
  const generation = useRef(0);
  const merge = (items: ToolVersionItem[], page: ToolVersionItem[]) => [...items, ...page.filter(item => !items.some(seen => seen.version === item.version))];
  const page = useCallback(async (fromStart: boolean): Promise<Loaded | null> => {
    if (!port) return null;
    const base = fromStart ? { items: [], cursor: null, loaded: false } : current.current;
    if (!fromStart && (!base.loaded || !base.cursor)) return base;
    const mine = fromStart ? ++generation.current : generation.current;
    setLoading(true); setError(null);
    try {
      const result = await port.versions(toolId, fromStart ? null : base.cursor);
      if (mine !== generation.current) return null;
      const next = { items: merge(base.items, result.items), cursor: result.nextCursor, loaded: true };
      current.current = next; setState(next); return next;
    } catch (failure) { if (mine === generation.current) setError(toolErrorOf(failure, 'load')); return null; }
    finally { if (mine === generation.current) setLoading(false); }
  }, [port, toolId]);
  useEffect(() => { void page(true); }, [page, refreshKey]);
  /** Load pages until `version` resolves against stored snapshots, then answer. Never one call per caller. */
  const ensure = useCallback(async (version: number): Promise<VersionResolution> => {
    let loaded: Loaded | null = current.current.loaded ? current.current : await page(true);
    for (let pages = 0; loaded && pages < MAX_ENSURE_PAGES; pages += 1) {
      const resolution = resolveVersion(version, loaded.items, loaded.cursor === null);
      if (resolution.kind !== 'unknown' || !loaded.cursor) return resolution;
      loaded = await page(false);
    }
    return { kind: 'unknown' };
  }, [page]);
  const resolve = useCallback((version: number) => state.loaded ? resolveVersion(version, state.items, state.cursor === null) : { kind: 'unknown' } as const, [state]);
  return { ...state, error, loading, more: () => page(false), reload: () => page(true), ensure, resolve };
}
export type ToolVersions = ReturnType<typeof useToolVersions>;

/** A run's pinned version, opened from Run history. */
export interface VersionFocus { version: number; sourceSha256: string; resolution: VersionResolution }

const fileName = (item: ToolVersionItem) => {
  const definition = snapshotDefinition(item);
  return `${definition.name ?? 'tool'}.${definition.runtime === 'python' ? 'py' : 'sh'}`;
};

export const Versions = forwardRef<HTMLElement, { versions: ToolVersions; focus: VersionFocus | null }>(function Versions({ versions, focus }, ref) {
  const { items, cursor, loaded, loading, error } = versions;
  const [chosen, setChosen] = useState<{ from: number; to: number } | null>(null);
  // A run's stored version selects itself once, against the stored version before it.
  const applied = useRef<VersionFocus | null>(null);
  useEffect(() => {
    if (!focus || applied.current === focus || focus.resolution.kind !== 'stored') return;
    const at = items.findIndex(item => item.version === focus.version);
    if (at < 0) return;
    applied.current = focus;
    setChosen({ to: focus.version, from: items[at + 1]?.version ?? focus.version });
  }, [focus, items]);
  // Default: latest against the stored version before it. A choice no longer listed falls back.
  const listed = (version: number | undefined) => items.some(item => item.version === version);
  const to = chosen && listed(chosen.to) ? chosen.to : items[0]?.version;
  const from = chosen && listed(chosen.from) ? chosen.from : items[1]?.version ?? items[0]?.version;
  const toItem = items.find(item => item.version === to), fromItem = items.find(item => item.version === from);
  const diff = useMemo(() => {
    if (!toItem || !fromItem) return null;
    const before = snapshotSource(fromItem), after = snapshotSource(toItem);
    if (before === null || after === null) return { kind: 'missing' as const };
    if (before === after) return { kind: 'same' as const };
    const text = unifiedSourceDiff(before, after, { from: fileName(fromItem), to: fileName(toItem) });
    return text ? { kind: 'diff' as const, text } : { kind: 'newline' as const };
  }, [fromItem, toItem]);
  const others = fromItem && toItem && fromItem !== toItem ? [...new Set([...scalarChanges(fromItem, toItem), ...changedFields(fromItem, toItem).filter(field => !['source', 'name', 'runtime', 'tm8 access', 'timeout'].includes(field))])] : [];
  const option = (item: ToolVersionItem) => <option key={item.version} value={item.version}>v{item.version}</option>;
  const focusHint = focus ? versionHint(focus.version, focus.resolution) : null;
  return <section ref={ref} aria-label="Versions" tabIndex={-1}><h3>Versions</h3>
    <p className="tool-note">Each row is a stored snapshot. Quick edits by one author within five minutes fold into one snapshot, so version numbers can skip.</p>
    <ToolErrorAlert error={error}> <button type="button" className="pn-btn" onClick={() => void versions.reload()}>Retry versions</button></ToolErrorAlert>
    {focus && (focusHint
      ? <p role="status" className="tool-notice">{focusHint} That run pinned source sha256 <code className="tool-sha">{focus.sourceSha256}</code>.</p>
      : focus.resolution.kind === 'unknown'
        ? <p role="status" className="tool-notice">v{focus.version} could not be found among the stored versions. That run pinned source sha256 <code className="tool-sha">{focus.sourceSha256}</code>.</p>
        : <p role="status" className="tool-notice">Showing v{focus.version}, the version that run executed (source sha256 <code title={focus.sourceSha256}>{shortSha(focus.sourceSha256)}</code>).</p>)}
    {!loaded && loading && <p role="status">Loading versions…</p>}
    {loaded && !items.length && !error && <p>No stored versions.</p>}
    {items.length > 0 && <div className="tool-table-scroll"><table className="tool-inputs tool-versions-table">
      <thead><tr><th>Version</th><th>Changed by</th><th>When</th><th>Changed</th><th><span className="tool-sr">Compare</span></th></tr></thead>
      <tbody>{items.map((item, index) => {
        const previous = items[index + 1];
        const fields = previous ? changedFields(previous, item) : cursor === null ? ['created'] : null;
        return <tr key={item.version} aria-current={item.version === to ? 'true' : undefined}>
          <td>v{item.version}</td>
          <td>{item.changedBy?.displayName ?? 'Unknown'}</td>
          <td><Timestamp at={item.changedAt} /></td>
          <td>{fields === null ? <span title="The version before this one is not loaded yet.">…</span> : fields.length ? fields.join(', ') : 'no definition change'}</td>
          <td>{previous && <button type="button" className="pn-btn" aria-label={`Compare v${item.version} with v${previous.version}`} onClick={() => setChosen({ from: previous.version, to: item.version })}>Compare</button>}</td>
        </tr>;
      })}</tbody>
    </table></div>}
    {cursor && <button type="button" className="pn-btn" disabled={loading} onClick={() => void versions.more()}>{loading ? 'Loading…' : 'More versions'}</button>}
    {items.length > 1 && from !== undefined && to !== undefined && <div className="tool-compare" aria-label="Source diff" role="group">
      <div className="tool-actions">
        <label>From <select aria-label="Compare from version" value={from} onChange={event => setChosen({ from: Number(event.target.value), to })}>{items.map(option)}</select></label>
        <label>To <select aria-label="Compare to version" value={to} onChange={event => setChosen({ from, to: Number(event.target.value) })}>{items.map(option)}</select></label>
      </div>
      {from === to ? <p>Choose two different versions to compare.</p>
        : diff?.kind === 'diff' ? <DiffView diff={diff.text} />
        : diff?.kind === 'same' ? <p>The source is the same in v{from} and v{to}.</p>
        : diff?.kind === 'newline' ? <p>The sources of v{from} and v{to} differ only in their final newline.</p>
        : <p>One of these snapshots carries no source.</p>}
      {from !== to && others.length > 0 && <p>Also changed between v{from} and v{to}: {others.join('; ')}.</p>}
    </div>}
  </section>;
});
