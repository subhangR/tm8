/**
 * Terminal-side user notices.
 *
 * packages/ui's equivalent routes through a toast store; tm8-ui has no toast
 * system — its notice vocabulary is `shell/notices.ts`, a ONE-card queue
 * driven by shell-level state that this lane does not own (D7's dev-flag
 * scope keeps the P2 transplant out of shell/). Rather than reach into
 * another lane's module or fabricate a toast system, this logs to the
 * console. The two call sites that use it (clipboard-copy failure,
 * unavailable image paste) are both non-fatal and already degrade
 * gracefully without a visible notice — this is a diagnostic aid, not a
 * dropped requirement.
 */
export type TerminalNoticeKind = 'info' | 'success' | 'warn';

export function notifyUser(message: string, kind: TerminalNoticeKind): void {
  const log = kind === 'warn' ? console.warn : console.info;
  log(`[terminal] ${message}`);
}
