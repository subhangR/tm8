/**
 * The one attention line a tile prints under S5a's chip (chapter 4, mock tabs
 * 4 and 5):
 *   · a work session or chat that raised an open request anywhere (F1):
 *     `waiting on you: <latest reason>`, `ended · …` once it has ended;
 *   · a roll-up root with rolled-up requests: `3 requests · 2 own, 1 via
 *     session #c09e`.
 * Display only — the top bar still counts the root once. Renders nothing
 * outside an `AttentionProvider`.
 */
import type { EntityId } from '@tm8/contract';
import type { AttentionApi } from './index';
import './attention-surfaces.css';
import { rollupLine, sessionWaitingLine } from './attention-subtitles';
import { raisesAttention } from '../domain/attention-kinds';

export function attentionTileLine(
  api: AttentionApi | null,
  row: { id: string; kind: string },
  ended: boolean,
  titleOf?: (id: string) => string | null | undefined,
): string | null {
  if (!api) return null;
  if (raisesAttention(row.kind)) {
    const raised = api.raisedChipFor(row.id as EntityId);
    if (raised) return sessionWaitingLine(raised.latestReason, ended);
  }
  return rollupLine(row.id as EntityId, api.requestsFor(row.id as EntityId), titleOf);
}

/**
 * The line itself. Presentational: the tile computes the line once with
 * `attentionTileLine` (it needs to know whether to open its badge band at all)
 * and hands it here, so production and the tests render the same markup.
 */
export function AttentionTileSubtitle({ line }: { line: string | null }) {
  if (!line) return null;
  return (
    <span className="att-tile-sub" data-testid="attention-tile-subtitle" title={line}>
      {line}
    </span>
  );
}
