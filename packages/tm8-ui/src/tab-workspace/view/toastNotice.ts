/**
 * A Work runtime toast as the shell's notice (task 01a182d2).
 *
 * CONTRACT: pure. In a `WorkspaceToast`, out a `Notice` that keeps the toast's
 * ACTION: the bind's "Created <title>" Open and a closed launch tab's Show are
 * the only way back to what they name, so a notice that dropped them would
 * strand it. Called by TabWorkspaceView's toast hook.
 */
import { NOTICE_TTL_MS, type Notice } from '../../shell/notices';
import type { WorkspaceToast } from '../runtime/types';

export function noticeOfToast(toast: WorkspaceToast): Notice {
  return {
    id: `tws-${Date.now()}`,
    tone: 'info',
    title: toast.text,
    body: '',
    ttlMs: NOTICE_TTL_MS,
    ...(toast.action ? { action: toast.action } : {}),
  };
}
