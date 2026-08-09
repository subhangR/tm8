import { notifyUser } from './notifications.js';

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  // Skip the async Clipboard API when the page is KNOWN to be insecure —
  // tm8 is routinely served over plain http:// on a LAN/tailnet address, where
  // `navigator.clipboard` is either absent or present-but-always-rejecting.
  // Awaiting a rejection there costs a microtask turn against the transient
  // user activation that the execCommand fallback below depends on, so we go
  // straight to the fallback instead. `=== false` deliberately: only an
  // explicit "not secure" skips: unknown (older/embedded/test) still tries.
  const insecure = typeof window !== 'undefined' && window.isSecureContext === false;
  try {
    if (!insecure && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the universal gesture-based path
  }
  if (!document.body) return false;
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  Object.assign(textarea.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
  });
  document.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    copied = document.execCommand?.('copy') === true;
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus?.();
  }
  return copied;
}

export async function copyToClipboardOrWarn(text: string, label = 'Text'): Promise<boolean> {
  if (!text) return false;
  const copied = await copyToClipboard(text);
  if (!copied) notifyUser(`${label} could not be copied — the browser blocked clipboard access.`, 'warn');
  return copied;
}
