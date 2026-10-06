/**
 * Dev hook (Spec B §3): `window.__tm8Workspace = { dispatch, inspect }` for
 * the mounted runtime — in dev builds, or when `?wsdev` is in the URL or
 * `localStorage['tm8.ws.dev'] === '1'` (the local test server runs prod builds).
 */
import type { WorkspaceRuntime } from './dispatch';

declare global {
  interface Window {
    __tm8Workspace?: Pick<WorkspaceRuntime, 'dispatch' | 'inspect'> & { runtime: WorkspaceRuntime };
  }
}

export function devHookEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (import.meta.env.DEV) return true;
  try {
    if (/[?&]wsdev\b/.test(window.location.search) || /[?&]wsdev\b/.test(window.location.hash)) {
      window.localStorage.setItem('tm8.ws.dev', '1');
      return true;
    }
    return window.localStorage.getItem('tm8.ws.dev') === '1';
  } catch {
    return false;
  }
}

/** Install for this runtime; returns the uninstall (only removes its own install). */
export function installDevHook(runtime: WorkspaceRuntime): () => void {
  if (!devHookEnabled()) return () => {};
  const hook = { dispatch: runtime.dispatch, inspect: runtime.inspect, runtime };
  window.__tm8Workspace = hook;
  return () => {
    if (window.__tm8Workspace === hook) delete window.__tm8Workspace;
  };
}
