/**
 * Theme choice — persisted, with a `prefers-color-scheme` default (LLD §11).
 *
 * The state table rules this exactly: owner "theme store", persistence
 * "localStorage; `prefers-color-scheme` default". Both halves matter and both
 * were missing: the shell held theme in an unpersisted `useState` seeded to
 * light, so every reload dropped the viewer's choice AND ignored their OS
 * preference on first visit.
 *
 * HOW IT WAS MISSED, recorded because the mechanism is the lesson: I found this
 * behaviour early and wrote it down — "theme is component state, not persisted;
 * a reload resets to light" — as a CAPTURE PROCEDURE CAVEAT, a thing to route
 * around when taking screenshots. I never asked whether the behaviour was
 * correct. A documented workaround reads like understanding, which is exactly
 * what stops it being re-examined; the note that should have been a bug report
 * became a procedure instead. (A1c hit the same behaviour from the other side
 * and read it as a dead control.)
 *
 * D1 governs the CONTROL's home — the account menu, never a tab-bar toggle —
 * and is unaffected by where the value is stored.
 */
import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

/** Viewer-local, not per-space: a person's theme follows them across spaces. */
const STORAGE_KEY = 'tm8ui.theme';

/** The OS preference — the ruled DEFAULT, used only when nothing is stored. */
function systemTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function storedTheme(): Theme | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    // Private mode / blocked storage. Not fatal: the session still themes,
    // it just cannot remember. Never let storage take the shell down.
    return null;
  }
}

export interface ThemeControl {
  theme: Theme;
  setTheme(theme: Theme): void;
  toggle(): void;
  /** True when the current value came from the OS rather than an explicit choice. */
  isSystemDefault: boolean;
}

export function useTheme(): ThemeControl {
  // Resolved in the initialiser so the FIRST paint is already correct — a
  // useEffect would render light, then flip, which is a visible flash for
  // every dark-mode viewer on every load.
  const [state, setState] = useState<{ theme: Theme; explicit: boolean }>(() => {
    if (typeof window === 'undefined') return { theme: 'light', explicit: false };
    const stored = storedTheme();
    return stored ? { theme: stored, explicit: true } : { theme: systemTheme(), explicit: false };
  });

  const setTheme = useCallback((theme: Theme) => {
    setState({ theme, explicit: true });
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // As above: the choice applies now even if it cannot be remembered.
    }
  }, []);

  const toggle = useCallback(
    () => setTheme(state.theme === 'dark' ? 'light' : 'dark'),
    [state.theme, setTheme],
  );

  // Follow the OS while the viewer has expressed no preference of their own.
  // Once they choose, their choice wins and the system stops overriding it.
  useEffect(() => {
    if (state.explicit || typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setState({ theme: query.matches ? 'dark' : 'light', explicit: false });
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [state.explicit]);

  return { theme: state.theme, setTheme, toggle, isSystemDefault: !state.explicit };
}
