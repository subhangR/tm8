/**
 * Minimal inline stroke icons (lucide-shaped) — the prototype uses lucide via
 * a web component; the app ships no icon dependency, so the shell draws the
 * dozen glyphs it needs itself. Everything inherits `currentColor`.
 */
import type { ReactNode } from 'react';

export type IconName =
  | 'home' | 'list-checks' | 'file-text' | 'users' | 'git-pull-request'
  | 'share-2' | 'trophy' | 'inbox' | 'hash' | 'pin' | 'maximize-2' | 'x'
  // ⚠ tm8 addition (drift ledger): 'columns' — the Workspace rail entry.
  | 'chevron-right' | 'settings' | 'square' | 'terminal' | 'columns';

const PATHS: Record<IconName, ReactNode> = {
  'home': <><path d="M3 9.5 10 3l7 6.5" /><path d="M5 9v8h10V9" /></>,
  'list-checks': <><path d="M3 5.5 4.5 7 7 4" /><path d="M3 13.5 4.5 15 7 12" /><path d="M10 5.5h7" /><path d="M10 13.5h7" /></>,
  'file-text': <><path d="M5 2.5h6l4 4V17.5H5z" /><path d="M11 2.5v4h4" /><path d="M7.5 11h5" /><path d="M7.5 14h5" /></>,
  'users': <><circle cx="7.5" cy="7" r="2.6" /><path d="M3 16c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" /><path d="M13 6.2a2.5 2.5 0 0 1 0 4.6" /><path d="M14 12.4c1.8.5 3 1.8 3 3.6" /></>,
  'git-pull-request': <><circle cx="5.5" cy="5" r="2" /><circle cx="5.5" cy="15" r="2" /><circle cx="14.5" cy="15" r="2" /><path d="M5.5 7v6" /><path d="M14.5 13V8a3 3 0 0 0-3-3H9" /><path d="m10.5 3.2-1.6 1.8 1.6 1.8" /></>,
  'share-2': <><circle cx="15" cy="4.5" r="2" /><circle cx="5" cy="10" r="2" /><circle cx="15" cy="15.5" r="2" /><path d="m13.2 5.6-6.4 3.3" /><path d="m6.8 11.1 6.4 3.3" /></>,
  'trophy': <><path d="M6 3h8v4a4 4 0 0 1-8 0z" /><path d="M6 4H3.5v1.5A2.5 2.5 0 0 0 6 8" /><path d="M14 4h2.5v1.5A2.5 2.5 0 0 1 14 8" /><path d="M10 11v3" /><path d="M7 17h6l-.7-3h-4.6z" /></>,
  'inbox': <><path d="M3 10.5 5 3.5h10l2 7v6H3z" /><path d="M3 10.5h4l1 2h4l1-2h4" /></>,
  'hash': <><path d="M4 7.5h12" /><path d="M4 12.5h12" /><path d="M8.5 3.5 7 16.5" /><path d="M13 3.5 11.5 16.5" /></>,
  'pin': <><path d="M8 2.5h4l-.6 4 2.6 2.5H6l2.6-2.5z" /><path d="M10 9v8.5" /></>,
  'maximize-2': <><path d="M11.5 3.5H16.5V8.5" /><path d="M8.5 16.5H3.5V11.5" /><path d="m16.5 3.5-5.5 5.5" /><path d="m3.5 16.5 5.5-5.5" /></>,
  'x': <><path d="m5 5 10 10" /><path d="m15 5-10 10" /></>,
  'chevron-right': <path d="m8 5 5 5-5 5" />,
  'settings': <><circle cx="10" cy="10" r="2.6" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" /></>,
  'square': <rect x="4" y="4" width="12" height="12" rx="3" />,
  // A shell prompt: the caret an agent's session runs behind.
  'terminal': <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="m6 8 2.5 2L6 12" /><path d="M10.5 12.5H14" /></>,
  // ⚠ tm8 addition: three columns — the workspace's own shape, so the rail entry
  // shows what the screen is rather than borrowing another section's glyph.
  'columns': <><rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path d="M7.5 3.5v13" /><path d="M12.5 3.5v13" /></>,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="cv2-icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
