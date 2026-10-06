import type { CommandContext } from './run.js';

/**
 * P0g (ac4): the server's `task_still_working` advisory — the caller's session
 * posted on, or linked code to, a task it still holds in `working`. Printed as
 * a `notice:` on stderr, in every output mode and never silenced by --quiet,
 * like D2's closed-recipient notice. The human receipt leaves it out, so the
 * line is said once; JSON keeps it in `warnings`.
 */
export const TASK_STILL_WORKING = 'task_still_working';

export function noticeStatusNudges(cmd: CommandContext, result: unknown): void {
  const warnings = (result as { warnings?: unknown } | null)?.warnings;
  if (!Array.isArray(warnings)) return;
  for (const w of warnings as Array<Record<string, unknown>>) {
    if (w?.code !== TASK_STILL_WORKING || typeof w.message !== 'string') continue;
    cmd.out.warn(`notice: ${w.message}`);
  }
}
