/**
 * The browser half of Secure Vault's chat paste guard (task 01a1fa87; brief v2 MSG 6 Journey A step 3).
 *
 * With TM8_VAULT_PASTE_GUARD on, the node removes secret-shaped text from what a person posts, or opens
 * a chat with, before it stores the message (packages/server/src/vault/paste-guard.ts). It answers a
 * `vault_paste_redacted` warning. That warning is the only sign the sender gets that the stored message
 * is not what they typed. It is also where the brief's required words go: the value already left the
 * device, so treat it as exposed. This module puts it on screen. The real seam hands every post and
 * chat start result here (data/real/seam-real.ts), and the shell shows the warning as a notice.
 *
 * The notice body is the server's text, unchanged. It names kinds of secret only, never a value.
 *
 * The shell registers the host once (views/GateApp.tsx), as it does the terminal's notice sink: the
 * seam sits below any React tree. With no host registered (tests, harnesses) the warning is not shown.
 * The node has stored the redacted text either way, and an API caller still reads the warning from the
 * result.
 */
import { VAULT_PASTE_WARNING_CODE, type ResultWarning } from '@tm8/contract';
import type { Notice } from '../shell/notices';

/** One card however many messages hit it: the shell replaces a notice with the same id. */
export const PASTE_NOTICE_ID = 'vault-paste-redacted';
/** The text is a paragraph that asks for an action, so it stays far longer than the shell's 6 s. */
export const PASTE_NOTICE_TTL_MS = 30_000;
export const PASTE_NOTICE_TITLE = 'Secret-shaped text removed';
export const PASTE_NOTICE_ACTION = 'Open Secure Vault';

export interface PasteWarningHost {
  readonly push: (notice: Notice) => void;
  /** Opens Settings → Secure vault. Absent where the page has no vault section (a server reached through the proxy). */
  readonly openVault?: () => void;
}

let host: PasteWarningHost | null = null;

/** Returns the un-register function, so a remounting shell cannot leave a stale host in the slot. */
export function registerPasteWarningHost(next: PasteWarningHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

/** The paste warning a write answered, or null. */
export function pasteWarningOf(result: unknown): ResultWarning | null {
  if (typeof result !== 'object' || result === null) return null;
  const warnings: unknown = (result as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return null;
  for (const warning of warnings) {
    if (typeof warning !== 'object' || warning === null) continue;
    const { code, message } = warning as { code?: unknown; message?: unknown };
    if (code === VAULT_PASTE_WARNING_CODE && typeof message === 'string') return { code, message };
  }
  return null;
}

/** Shows the paste warning a post or chat start answered, and returns the result unchanged. */
export function surfacePasteWarning<T>(result: T): T {
  const warning = pasteWarningOf(result);
  const target = host;
  if (warning === null || target === null) return result;
  const openVault = target.openVault;
  try {
    target.push({
      id: PASTE_NOTICE_ID,
      tone: 'warn',
      title: PASTE_NOTICE_TITLE,
      body: warning.message,
      ttlMs: PASTE_NOTICE_TTL_MS,
      ...(openVault ? { action: { label: PASTE_NOTICE_ACTION, run: openVault } } : {}),
    });
  } catch {
    // The message is already stored. A notice that fails to render must not turn that into a failed
    // send, or the composer would offer to send it again.
  }
  return result;
}
