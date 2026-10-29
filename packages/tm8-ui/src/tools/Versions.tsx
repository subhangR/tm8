import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiffView } from '../kit/DiffView';
import { Timestamp } from '../kit/Timestamp';
import type { ToolPort } from './port';
import { toolErrorOf, type ToolErrorView } from './errors';
import { ToolErrorAlert } from './ToolErrorAlert';
import { shortSha } from './values';
import { snapshotVersionOf } from './version-field';
import { unifiedSourceDiff } from './source-diff';
import {
  changeLabels, changedFields, classifyVersions, resolveVersion, scalarChanges, snapshotDefinition, snapshotSource, versionHint,
  type ToolVersionItem, type ToolVersionRow, type VersionResolution,
} from './versions-model';

/** Bounds the walk a run's version may trigger: 50 pages of 20 is a thousand stored versions. */
const MAX_ENSURE_PAGES = 50;
interface Loaded { items: ToolVersionItem[]; cursor: string | null; loaded: boolean }
const classify = (loaded: Loaded) => classifyVersions(loaded.items, loaded.cursor === null);

/** Stored versions, newest first. One page loads with the page; more only on request. */
export function useToolVersions(port: ToolPort | undefined, toolId: string, refreshKey: unknown) {
  const [state, setState] = useState<Loaded>({ items: [], cursor: null, loaded: false });
  const [error, setError] = useState<ToolErrorView | null>(null);
  const [loading, setLoading] = useState(false);
  const current = useRef(state);
  current.current = state;
  const generation = useRef(0);
  const merge = (items: ToolVersionItem[], page: ToolVersionItem[]) => [...items, ...page.filter(item => !items.some(seen => snapshotVersionOf(seen) === snapshotVersionOf(item)))];
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
      const resolution = resolveVersion(version, classify(loaded), loaded.cursor === null);
      if (resolution.kind !== 'unknown' || !loaded.cursor) return resolution;
      loaded = await page(false);
    }
    return { kind: 'unknown' };
  }, [page]);
  const rows = useMemo(() => state.loaded ? classify(state) : [], [state]);
  const resolve = useCallback((version: number) => state.loaded ? resolveVersion(version, rows, state.cursor === null) : { kind: 'unknown' } as const, [state, rows]);
  return { ...state, rows, error, loading, more: () => page(false), reload: () => page(true), ensure, resolve };
}
export type ToolVersions = ReturnType<typeof useToolVersions>;

/** A run's pinned version, opened from Run history. */
export interface VersionFocus { version: number; sourceSha256: string; resolution: VersionResolution }

const fileName = (item: ToolVersionItem) => {
  const definition = snapshotDefinition(item);
  return `${definition.name ?? 'tool'}.${definition.runtime === 'python' ? 'py' : 'sh'}`;
};

export const Versions = forwardRef<HTMLElement, { versions: ToolVersions; focus: VersionFocus | null }>(function Versions({ versions, focus }, ref) {
  const { rows, cursor, loaded, loading, error } = versions;
  const [showAll, setShowAll] = useState(false);
  const [chosen, setChosen] = useState<{ from: number; to: number } | null>(null);
  // Definition versions are what runs pin and what the diff compares; the other writes show on request.
  const definitions = useMemo(() => rows.filter(row => row.definition), [rows]);
  const listed = showAll ? rows : definitions;
  const hidden = rows.length - definitions.length;
  // A run's stored row selects the definition version it ran as, once, against the definition version before it.
  const applied = useRef<VersionFocus | null>(null);
  useEffect(() => {
    if (!focus || applied.current === focus || focus.resolution.kind !== 'stored') return;
    const target = focus.resolution.row.executionVersion;
    const at = definitions.findIndex(row => row.version === target);
    if (at < 0) return;
    applied.current = focus;
    setChosen({ to: target, from: definitions[at + 1]?.version ?? target });
  }, [focus, definitions]);
  // Default: the two newest definition versions. A choice no longer listed falls back.
  const has = (version: number | undefined) => definitions.some(row => row.version === version);
  const to = chosen && has(chosen.to) ? chosen.to : definitions[0]?.version;
  const from = chosen && has(chosen.from) ? chosen.from : definitions[1]?.version ?? to;
  const toRow = definitions.find(row => row.version === to), fromRow = definitions.find(row => row.version === from);
  const diff = useMemo(() => {
    if (!toRow || !fromRow) return null;
    const before = snapshotSource(fromRow.item), after = snapshotSource(toRow.item);
    if (before === null || after === null) return { kind: 'missing' as const };
    if (before === after) return { kind: 'same' as const };
    const text = unifiedSourceDiff(before, after, { from: fileName(fromRow.item), to: fileName(toRow.item) });
    return text ? { kind: 'diff' as const, text } : { kind: 'newline' as const };
  }, [fromRow, toRow]);
  const others = fromRow && toRow && fromRow !== toRow
    ? [...new Set([...scalarChanges(fromRow.item, toRow.item), ...changedFields(fromRow.item, toRow.item).filter(field => !['source', 'name', 'runtime', 'tm8Access', 'timeoutSeconds'].includes(field)).map(field => changeLabels([field]))])]
    : [];
  const option = (row: ToolVersionRow) => <option key={row.version} value={row.version}>v{row.version}</option>;
  const focusHint = focus ? versionHint(focus.version, focus.resolution) : null;
  const focusVersion = focus?.resolution.kind === 'stored' ? focus.resolution.row.executionVersion : null;
  return <section ref={ref} aria-label="Versions" tabIndex={-1}><h3>Versions</h3>
    <p className="tool-note">A version is a change to what runs: source, runtime, inputs, tm8 access or timeout. Help, description, name, configuration and secret writes keep their own snapshots too; show all writes to see them.</p>
    <ToolErrorAlert error={error}> <button type="button" className="pn-btn" onClick={() => void versions.reload()}>Retry versions</button></ToolErrorAlert>
    {focus && (focusHint
      ? <p role="status" className="tool-notice">{focusHint} That run pinned source sha256 <code className="tool-sha">{focus.sourceSha256}</code>.</p>
      : focus.resolution.kind === 'unknown'
        ? <p role="status" className="tool-notice">Source unavailable: v{focus.version} was not found among the stored versions. That run pinned source sha256 <code className="tool-sha">{focus.sourceSha256}</code>.</p>
        : <p role="status" className="tool-notice">Showing v{focusVersion}, the version that run executed (source sha256 <code title={focus.sourceSha256}>{shortSha(focus.sourceSha256)}</code>).</p>)}
    {!loaded && loading && <p role="status">Loading versions…</p>}
    {loaded && !rows.length && !error && <p>No stored versions.</p>}
    {rows.length > 0 && <>
      <div className="tool-actions"><label className="tool-versions__toggle"><input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)} /> Show all writes{hidden > 0 && !showAll ? ` (${hidden} hidden)` : ''}</label></div>
      <div className="tool-table-scroll"><table className="tool-inputs tool-versions-table">
        <thead><tr><th>Version</th><th>Changed by</th><th>When</th><th>Changed</th><th><span className="tool-sr">Compare</span></th></tr></thead>
        <tbody>{listed.map((row, index) => {
          const previous = listed[index + 1];
          // Against the row above it in this view: between two definition versions that spans the writes hidden between them.
          const changed = previous ? changedFields(previous.item, row.item) : row.changed;
          const label = changed === null ? null : changed.length ? changeLabels(changed) : previous ? 'no change' : 'created';
          return <tr key={row.version} data-version={row.version} data-definition={row.definition ? 'true' : undefined} aria-current={row.definition && row.version === to ? 'true' : undefined}>
            <td className="tool-run-version">
              {row.definition ? <>v{row.version}{row.sourceSha256 && <> <code title={`source sha256 ${row.sourceSha256}`}>{shortSha(row.sourceSha256)}</code></>}</>
                : <>v{row.executionVersion} <small className="tool-run-version__note" title={`Write ${row.version} changed ${label ?? 'something not loaded yet'}; it runs as v${row.executionVersion}.`}>· {label ?? '…'}</small></>}
            </td>
            <td>{row.item.changedBy?.displayName ?? 'Unknown'}</td>
            <td><Timestamp at={row.item.changedAt} /></td>
            <td>{label === null ? <span title="The write before this one is not loaded yet.">…</span> : label}</td>
            <td>{row.definition && previous?.definition && <button type="button" className="pn-btn" aria-label={`Compare v${row.version} with v${previous.version}`} onClick={() => setChosen({ from: previous.version, to: row.version })}>Compare</button>}</td>
          </tr>;
        })}</tbody>
      </table></div>
    </>}
    {cursor && <button type="button" className="pn-btn" disabled={loading} onClick={() => void versions.more()}>{loading ? 'Loading…' : 'More versions'}</button>}
    {definitions.length > 1 && from !== undefined && to !== undefined && <div className="tool-compare" aria-label="Source diff" role="group">
      <div className="tool-actions">
        <label>From <select aria-label="Compare from version" value={from} onChange={event => setChosen({ from: Number(event.target.value), to })}>{definitions.map(option)}</select></label>
        <label>To <select aria-label="Compare to version" value={to} onChange={event => setChosen({ from, to: Number(event.target.value) })}>{definitions.map(option)}</select></label>
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
