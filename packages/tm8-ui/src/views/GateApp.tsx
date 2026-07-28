/**
 * GateApp — the complete T0-1 master screen, composed (R5 THE GATE).
 *
 * Boot order matters and is deliberate: identity/spaces/menu resolve before
 * anything renders content, the rail falls back to the shipped default when the
 * seam has no menu row (which is the fixture path, so the gate exercises
 * fail-closed for real), and the workspace mounts only once a space exists.
 *
 * The three lanes keep their authority: geometry sizes, navStore owns panel
 * state and the URL, the panels own anatomy. This file is composition only.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import {
  MenuRail,
  NoticeHost,
  SpaceTabBar,
  useNotices,
  type KindPresenter,
  type MenuTarget,
} from '../shell';
import type { NavPort } from '../shell/nav-port';
import { navStore, useNavStore } from '../stores/navStore';
import { getKind } from '../domain';
import type { DetailReasons } from '../panels';
import {
  authoredFromHollowReason,
  homeActivityLoadEarlierReason,
  presenceHollowReason,
} from '../fixtures';
import { useGateData } from './useGateData';
import { WorkspaceView } from './WorkspaceView';

/** The two workspace side panels (§5.1 defaults). Registry slugs, not literals. */
const LEFT_KIND = 'task';
const RIGHT_KIND = 'work_session';

export function GateApp() {
  const data = useGateData({ leftKind: LEFT_KIND, rightKind: RIGHT_KIND });
  const notices = useNotices();

  // Theme: both themes are acceptance criteria from day one (§12). The toggle
  // lives in the account menu (D1) — never in the tab bar.
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [menuCollapsed, setMenuCollapsed] = useState(false);
  const [activeTarget, setActiveTarget] = useState<MenuTarget | null>({
    type: 'view',
    ref: 'workspace',
  });

  const stack = useNavStore((s) => s.stack);
  const pinned = useNavStore((s) => s.pinned);

  // Bind A1a's store to my narrow port. This is the adapter nav-port.ts exists
  // for: shell drives a small, explicit surface rather than the whole store.
  const nav = useMemo<NavPort>(() => {
    const actions = navStore.getState();
    return {
      stack,
      pinned,
      push: (id) => actions.push(id),
      pop: () => actions.pop(),
      close: (id) => actions.close(id),
      pin: (id) => actions.pin(id),
      unpin: (id) => actions.unpin(id),
      promote: (id) => actions.promote(id),
      applyNormalization: (next) => actions.applyNormalization(next),
    };
  }, [stack, pinned]);

  // ⌘\ toggles the rail (§4.1). The full C6 controller is a separate lane; this
  // is the one binding the shell owns outright.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '\\' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setMenuCollapsed((collapsed) => !collapsed);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * Kind refs resolve through the DOMAIN REGISTRY (§15.2) — shell never maps a
   * kind itself. `getKind` falls back to the `c:*` row on a miss, so the
   * identity check is what makes an unknown ref unrenderable rather than
   * silently generic (A1a's landing note).
   */
  const presentKind = useCallback<KindPresenter>((ref) => {
    const row = getKind(ref);
    if (row.kind !== ref) return null;
    const live = ref === RIGHT_KIND ? data.liveIds.length : undefined;
    return { label: row.labelPlural, icon: row.icon as unknown as string, live };
  }, [data.liveIds.length]);

  const reasons = useMemo<DetailReasons>(
    () => ({
      presenceHollow: presenceHollowReason,
      versionHistory: 'Version history isn’t available yet.',
      provenanceHollow: authoredFromHollowReason,
      shareUnavailable: 'Sharing into a session isn’t available yet.',
      withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
    }),
    [],
  );
  void homeActivityLoadEarlierReason; // D7.1 — consumed by HomeView at fan-out.

  return (
    <div className="cv2-root" data-theme={theme === 'dark' ? 'dark' : undefined}>
      <div className="shell-root">
        <SpaceTabBar
          spaces={data.spaces}
          activeSpaceId={data.spaceId || null}
          onSelectSpace={(id: SpaceId) => void id}
          accountInitial="A"
          // D1: theme's one home is the account menu. No tab-bar toggle.
          onOpenAccount={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
        />

        <div className="shell-body">
          <MenuRail
            config={data.menu.config}
            collapsed={menuCollapsed}
            onToggle={() => setMenuCollapsed((c) => !c)}
            activeTarget={activeTarget}
            onNavigate={setActiveTarget}
            presentKind={presentKind}
          />

          {data.ready ? (
            <WorkspaceView
              data={data}
              nav={nav}
              leftKind={LEFT_KIND}
              rightKind={RIGHT_KIND}
              menuCollapsed={menuCollapsed}
              reasons={reasons}
              onNotice={notices.push}
              onPinRefusal={(_id: EntityId, refusal: string) =>
                notices.push({
                  id: 'pin-refused',
                  tone: 'warn',
                  title: 'Panel not pinned',
                  body: refusal,
                  ttlMs: 6000,
                })
              }
            />
          ) : (
            <div className="shell-boot" role="status">
              loading workspace…
            </div>
          )}
        </div>

        <NoticeHost notices={notices.notices} onDismiss={notices.dismiss} />
      </div>
    </div>
  );
}
