import { notifyUser } from './notifications.js';

export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
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
    position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', opacity: '0',
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
