import type { ToolLastRun } from '@tm8/contract';
import { Pill } from '../kit/Pill';
import { Timestamp } from '../kit/Timestamp';
import { runLabel, runTone } from './values';

/** The header's answer to "did it work last time?": outcome and when, opening that run. */
export function LastRunChip({ run, onOpen }: { run: ToolLastRun | null; onOpen?(sessionId: string): void }) {
  if (!run) return <span className="tool-last-run" data-testid="tool-last-run">Never run</span>;
  const at = run.exitedAt ?? run.startedAt;
  const body = <><span className="tool-last-run__label">Last run</span><Pill tone={runTone(run)}>{runLabel(run)}</Pill>{at && <Timestamp at={at} />}</>;
  return onOpen
    ? <button type="button" className="pn-btn tool-last-run" data-testid="tool-last-run" title="Open the last run" onClick={() => onOpen(run.sessionId)}>{body}</button>
    : <span className="tool-last-run" data-testid="tool-last-run">{body}</span>;
}
