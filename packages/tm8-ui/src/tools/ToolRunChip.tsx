import type { ToolRun } from '@tm8/contract';
import { Pill } from '../kit/Pill';
import { runLabel } from './values';

/** Tool outcome is independent of PTY liveness; this chip never closes the terminal. */
export function ToolRunChip({ run }: { run: ToolRun }) {
  return <div className="tool-run-status" role="status"><Pill tone={run.state === 'running' ? 'run' : run.state !== 'exited' || run.exitCode !== 0 ? 'block' : 'idle'}>{runLabel(run)}</Pill>
    {run.keepOpen && run.state !== 'running' && <span>The shell stays open until you close this tab.</span>}
  </div>;
}
