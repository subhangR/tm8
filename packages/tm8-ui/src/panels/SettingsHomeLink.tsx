import type { SettingsHome } from '../domain';
import { navStore } from '../stores/navStore';

/**
 * The door from a kind's Home list or panel to the Settings section that
 * manages it (`KindConfig.settingsHome`). Home lists every kind, and for a
 * credential or a space link the human-only verbs — add, rotate, sign in,
 * remove — live in Settings and nowhere else; this is how the list stops
 * being a dead end. A route, not a callback threaded through every host, the
 * same way `openJevKeySettings` reaches Agent credentials.
 */
export function SettingsHomeLink({ home, compact = false }: { home: SettingsHome; compact?: boolean }) {
  return (
    <button
      type="button"
      className={compact ? 'lp__settings' : 'pn-settings-home'}
      data-testid="settings-home-link"
      onClick={() => navStore.getState().navigate({ view: 'settings', section: home.section })}
    >
      {home.label} →
    </button>
  );
}
