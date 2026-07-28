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
import { buildSpawnInput } from '../domain/launch';
import type { DetailReasons } from '../panels';
import {
  authoredFromHollowReason,
  homeActivityLoadEarlierReason,
  presenceHollowReason,
} from '../fixtures';
import { useGateData } from './useGateData';
import { useSidePanelKinds } from './useSidePanelKinds';
import { useLaunchSheet } from './useLaunchSheet';
import { useTheme } from '../theme/useTheme';
import { WorkspaceView } from './WorkspaceView';

/**
 * §5.1's ruled side-panel defaults: left=tasks, right=sessions. These are the
 * only kind names in the shell layer; §15.2 wants them in `domain/` beside the
 * registry (the D18 precedent for SHIPPED_DEFAULT_MENU) — flagged to
 * fe-coordinator for routing rather than moved across a lane boundary here.
 */
const DEFAULT_LEFT_KIND = 'task';
const DEFAULT_RIGHT_KIND = 'work_session';

export function GateApp() {
  // Boot hydrates the RULED defaults; the viewer's persisted choice is applied
  // after, because the persistence is scoped per (viewer, space) and the space
  // id only exists once the seam has answered. Passing a placeholder id here
  // would silently disable persistence altogether — the storage key would never
  // match the one the next session reads.
  const data = useGateData({ leftKind: DEFAULT_LEFT_KIND, rightKind: DEFAULT_RIGHT_KIND });
  const kinds = useSidePanelKinds({
    viewerId: 'viewer',
    spaceId: data.spaceId,
    defaultLeft: DEFAULT_LEFT_KIND,
    defaultRight: DEFAULT_RIGHT_KIND,
  });

  // A kind chosen after boot (or restored from storage) may never have been
  // queried — hydrate it on demand rather than rendering an empty panel that
  // looks like "this kind has no rows".
  useEffect(() => {
    data.ensureKind(kinds.leftKind);
    data.ensureKind(kinds.rightKind);
  }, [data, kinds.leftKind, kinds.rightKind]);
  const notices = useNotices();

  // Theme: PERSISTED, with a prefers-color-scheme default (LLD §11). It was an
  // unpersisted useState seeded to light, so every reload discarded the
  // viewer's choice. The control's home is still the account menu (D1).
  const { theme, toggle: toggleTheme } = useTheme();
  const [menuCollapsed, setMenuCollapsed] = useState(false);
  const [activeTarget, setActiveTarget] = useState<MenuTarget | null>({
    type: 'view',
    ref: 'workspace',
  });

  const stack = useNavStore((s) => s.stack);
  const pinned = useNavStore((s) => s.pinned);

  // D44/D51 launch sheet. Transient client state — never the URL (§11), so a
  // shared link cannot open someone else's half-configured spawn surface.
  // Obligation 2 rides here: `hostedIds` is what clears the sheet when its
  // subject stops being hosted, by ANY route out (pop, close, promote, or a
  // hydration nobody dispatched).
  const launch = useLaunchSheet({ hostedIds: [...pinned, ...stack] });

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
    const live = ref === DEFAULT_RIGHT_KIND ? data.liveIds.length : undefined;
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
          onOpenAccount={toggleTheme}
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
              leftKind={kinds.leftKind}
              rightKind={kinds.rightKind}
              onLeftKindChange={kinds.setLeftKind}
              onRightKindChange={kinds.setRightKind}
              onLaunchOpen={(id) => launch.open(id)}
              launchSubjectId={launch.subjectId}
              isModalOpen={launch.isModalOpen}
              onLaunchCancel={launch.close}
              // D44: the sheet's Launch PERFORMS. A brass primary that cannot
              // do its verb reads as working at a glance and only corrects
              // itself after a click — the same misleading-glance shape as a
              // transient refusal wearing the permanent form. The honest fix
              // is to wire it, not to grey it out.
              onLaunchSubmit={(config) => {
                launch.close();
                void data
                  .spawn(
                    buildSpawnInput({
                      clientMutationId: `launch:${config.subjectId}:${config.teammateId}`,
                      spaceId: data.spaceId,
                      config: {
                        teamMemberId: config.teammateId,
                        target: config.projectIds.length
                          ? { kind: 'project', projectId: config.projectIds[0] as never }
                          : { kind: 'scratch' },
                      } as never,
                      taskIds: [config.subjectId],
                    }),
                  )
                  .then(() =>
                    notices.push({
                      id: 'launch-done',
                      tone: 'warn',
                      title: 'Session launched',
                      body: 'The session is running and appears in the live set.',
                      ttlMs: 6000,
                    }),
                  )
                  .catch((error: unknown) =>
                    // A refusal is a FACT about the node, not a UI failure —
                    // it renders with its own cause rather than a generic
                    // apology (T5-5's refusal grammar).
                    notices.push({
                      id: 'launch-refused',
                      tone: 'error',
                      title: 'Launch refused',
                      body: String((error as { message?: string })?.message ?? error),
                      ttlMs: 6000,
                    }),
                  );
              }}
              onSpawn={(input) => data.spawn(input)}
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
