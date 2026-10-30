import type { ToolRun } from '@tm8/contract';
import { Pill } from '../kit/Pill';
import { runLabel, runTone } from './values';

/** Tool outcome is independent of PTY liveness; this chip never closes the terminal. */
export function ToolRunChip({ run, shellLive = false }: { run: ToolRun; shellLive?: boolean }) {
  return <div className="tool-run-status" role="status"><Pill tone={runTone(run)}>{runLabel(run)}</Pill>
    {shellLive && run.keepOpen && run.state !== 'running' && <span>The shell stays open until you close this tab.</span>}
  </div>;
}
