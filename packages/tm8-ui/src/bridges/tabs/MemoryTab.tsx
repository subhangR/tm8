import { useCallback, useEffect, useState } from 'react';
import type { BridgeView, EdgeView, EntitySummary } from '@tm8/contract';
import { shortDate } from '../../kit/time';
import type { BridgesPort } from '../api';
import { bridgeFailureOf } from '../format';

/**
 * MEMORY (BRIDGES-V2-DESIGN §2.1): the memories this bridge `remembers` — the
 * same edge a teammate or a task uses, no new table. Link adds the edge,
 * Unlink drops the edge and never the memory (other holders may remember it).
 *
 * Proposals from WhatsApp (`/remember`) arrive with the command layer; this
 * tab draws the accepted set. Where the memories reach depends on the target,
 * and the tab says so rather than implying every agent carries them.
 */
export function MemoryTab({
  view,
  port,
  onOpenEntity,
}: {
  view: BridgeView;
  port: Pick<BridgesPort, 'memories' | 'memoryCandidates' | 'linkMemory' | 'unlinkMemory'>;
  onOpenEntity?: (id: string) => void;
}) {
  const [edges, setEdges] = useState<EdgeView[] | null>(null);
  const [candidates, setCandidates] = useState<EntitySummary[]>([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setEdges(await port.memories(view.id));
      setError(null);
    } catch (err) {
      setError(bridgeFailureOf(err));
    }
  }, [port, view.id]);

  useEffect(() => {
    void reload();
    void port.memoryCandidates(view.spaceId).then(setCandidates, () => setCandidates([]));
  }, [reload, port, view.spaceId]);

  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
      await reload();
    } catch (err) {
      setError(bridgeFailureOf(err));
    } finally {
      setBusy(null);
    }
  };

  const linked = new Set((edges ?? []).map((e) => e.target.id));
  const open = candidates.filter((c) => !linked.has(c.id));
  const reach = view.target.kind === 'chat'
    ? `Agents working for ${view.title} carry these: each turn in ${view.target.title}, and every worker started from this bridge.`
    : view.target.kind === 'work_session'
      ? `Workers started from this bridge carry these. Messages delivered to ${view.target.title} carry none: a running session's working set is fixed.`
      : `Workers started from this bridge carry these. Nobody in #${view.target.title} answers by default.`;

  return (
    <div className="brg-memory" data-testid="bridge-memory">
      <p className="brg-hint">{reach}</p>
      {edges === null ? (
        error ? <p className="brg-error" role="alert">{error}</p> : <p className="brg-hint" role="status">Loading memories…</p>
      ) : edges.length === 0 ? (
        <p className="brg-hint" data-testid="bridge-memory-empty">No memory is linked to this bridge.</p>
      ) : (
        <ul className="brg-memory__list">
          {edges.map((e) => (
            <li key={e.id} className="brg-memory__row">
              <span aria-hidden="true">🧠</span>
              {onOpenEntity ? (
                <button type="button" className="brg-link brg-memory__title" onClick={() => onOpenEntity(e.target.id)}>{e.target.title}</button>
              ) : <span className="brg-memory__title">{e.target.title}</span>}
              <span className="brg-muted">linked by {e.createdBy.displayName} · {shortDate(e.createdAt)}</span>
              <button
                type="button"
                className="pn-btn"
                disabled={busy !== null}
                aria-label={`Unlink ${e.target.title}`}
                onClick={() => void run(e.id, () => port.unlinkMemory(e.id))}
              >
                {busy === e.id ? 'Unlinking…' : 'Unlink'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="brg-memory__add"
        onSubmit={(event) => {
          event.preventDefault();
          if (pick) void run('link', () => port.linkMemory(view.id, pick)).then(() => setPick(''));
        }}
      >
        <label>
          <span className="set-eyebrow">Link a memory</span>
          <select value={pick} onChange={(event) => setPick(event.target.value)} aria-label="Memory to link" disabled={busy !== null || open.length === 0}>
            <option value="">{open.length === 0 ? 'No other memory in this space' : 'Choose a memory…'}</option>
            {open.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </label>
        <button type="submit" className="pn-btn pn-btn--primary" disabled={!pick || busy !== null}>
          {busy === 'link' ? 'Linking…' : '+ Link'}
        </button>
      </form>
      {edges !== null && error ? <p className="brg-error" role="alert">{error}</p> : null}
    </div>
  );
}
