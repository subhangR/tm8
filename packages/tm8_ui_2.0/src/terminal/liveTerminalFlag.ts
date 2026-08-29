/**
 * Whether a live work-session mounts the real xterm/PTY transport.
 *
 * The terminal is a production feature now, so browsers default to ON. Tests
 * stay OFF unless they explicitly opt in, which keeps component tests from
 * opening WebSockets. Operators can explicitly disable the terminal with
 * `VITE_TM8_LIVE_TERMINAL=0` or the matching localStorage value.
 */
export interface LiveTerminalEnv {
  MODE?: string;
  VITE_TM8_LIVE_TERMINAL?: string;
}

export const LIVE_TERMINAL_STORAGE_KEY = 'tm8-ui:live-terminal';

export function resolveLiveTerminalEnabled(
  env: LiveTerminalEnv,
  storedFlag: string | null,
): boolean {
  const envFlag = env.VITE_TM8_LIVE_TERMINAL;
  if (envFlag != null && envFlag !== '') return envFlag === '1';
  if (storedFlag !== null) return storedFlag === '1';
  if (env.MODE === 'test') return false;
  return true;
}

function readStoredFlag(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(LIVE_TERMINAL_STORAGE_KEY);
  } catch {
    // Storage can be blocked by the browser. That must not silently disable a
    // core production surface; the environment/default still decides.
    return null;
  }
}

export function isLiveTerminalEnabled(): boolean {
  return resolveLiveTerminalEnabled(
    import.meta.env as unknown as LiveTerminalEnv,
    readStoredFlag(),
  );
}
