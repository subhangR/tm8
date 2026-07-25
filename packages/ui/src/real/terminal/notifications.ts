import { pushToast, useToastStore } from '../../collab-v2/subsystems/live/toast';

export type TerminalNoticeKind = 'info' | 'success' | 'warn';

export function notifyUser(message: string, kind: TerminalNoticeKind): string {
  return pushToast({ kind: kind === 'warn' ? 'error' : kind, message });
}

export function dismissNotice(id: string): void {
  useToastStore.getState().dismiss(id);
}
