/**
 * tm8 web entry.
 *
 * Boots the transplanted collab-v2 shell against the real tm8 server, and
 * keeps the seeded MockFacade one query parameter away (`?mock`) so the module
 * still runs standalone with no node at all — which is how the 270-file
 * snapshot was gate-verified, and how a UI regression gets isolated from a
 * server regression.
 *
 * Everything the user might mistake for data is labelled before it renders:
 * which world they are in, and — while the space list is still loading or
 * empty — that the emptiness is a real answer from a real server rather than
 * a screen that has not finished.
 */
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CollabV2App } from './collab-v2/CollabV2App';
import type { SpaceSummary } from './collab-v2/types/contract';
import { ModeBanner } from './real/ModeBanner';
import { createRealFacade, type RealFacade } from './real/RealFacade';
import { SessionsScreen } from './real/sessions/SessionsScreen';
import { SpacePicker } from './real/SpacePicker';
import { SpawnDialog } from './real/SpawnDialog';
import { installTm8Kinds } from './real/tm8Kinds';
import { useNavStore } from './collab-v2/stores/nav';
import { WorkspaceScreen } from './real/workspace/WorkspaceScreen';

/**
 * Screens the tm8 node supplies to the module's shell. Sessions is here rather
 * than inside collab-v2 because it mounts a live PTY terminal over a tm8
 * WebSocket and reads the `work_session` kind — both tm8-specific, and the
 * module is backend-agnostic by law. See CollabV2App's `extraViews`.
 *
 * `workspace` is an ADDITION, not an override, and that distinction was a
 * deliberate call: an earlier cut of this registered `tasks: WorkspaceScreen`,
 * which worked — `extraViews` is merged last — but it silently replaced the
 * module's own Tasks screen, so the snapshot shipped a screen no route could
 * reach. The workspace now has its own rail entry and its own route, and
 * `#/s/{space}/tasks` still opens the module's screen exactly as before.
 */
const TM8_VIEWS = { sessions: SessionsScreen, workspace: WorkspaceScreen };

/**
 * Views that render as the whole window, with no module chrome around them.
 *
 * Declared once and used twice — the shell reads it to omit its rails, and the
 * mode banner reads it to stop consuming a strip of layout — so the two can
 * never disagree about which route is full-bleed.
 */
const FULL_BLEED_VIEWS = ['workspace'] as const;

// Must run before the first render: the shell resolves kinds through
// registryFor(), which has no fallback, so a work_session reaching a chip
// before this ran is a crash rather than a degraded card.
installTm8Kinds();

const useMock = new URLSearchParams(window.location.search).has('mock');

/** Boot states, kept explicit so none of them can be mistaken for another. */
type Boot =
  | { phase: 'loading' }
  | { phase: 'ready'; spaces: SpaceSummary[] }
  | { phase: 'failed'; message: string };

function RealApp({ facade }: { facade: RealFacade }) {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' });
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);

  useEffect(() => facade.subscribeConnection(setConnected), [facade]);

  const load = () => {
    setBoot({ phase: 'loading' });
    facade.listSpaces().then(
      (spaces) => {
        setBoot({ phase: 'ready', spaces });
        // Deep-link support, and it is validated against the server's list
        // rather than trusted: a stale hash must not mount the shell on a
        // space id that no longer exists.
        const fromHash = window.location.hash.match(/space=([0-9a-f-]+)/i)?.[1];
        const chosen = spaces.find((s) => s.id === fromHash) ?? spaces[0];
        setSpaceId(chosen?.id ?? null);
      },
      (err) => setBoot({ phase: 'failed', message: String(err?.message ?? err) }),
    );
  };

  useEffect(load, [facade]);

  // Read from the store the shell already owns rather than tracked separately:
  // the banner has to agree with the shell about which route is full-bleed, and
  // two sources of that truth would drift.
  const view = useNavStore((s) => s.view);

  const banner = (
    <ModeBanner
      mode="real"
      detail="tm8 catalog over /v2 (proxied)"
      connected={connected}
      floating={(FULL_BLEED_VIEWS as readonly string[]).includes(view)}
    />
  );

  if (boot.phase !== 'ready' || !spaceId) {
    return (
      <>
        {banner}
        <SpacePicker
          boot={boot}
          facade={facade}
          onRetry={load}
          onPick={(id) => { window.location.hash = `space=${id}`; setSpaceId(id); }}
        />
      </>
    );
  }

  return (
    <>
      <CollabV2App
        key={spaceId}
        facade={facade}
        spaceId={spaceId}
        banner={banner}
        extraViews={TM8_VIEWS}
        // The workspace is a transplant of maestro's whole window — its own
        // project tab bar and icon rail — so the module's rails would double
        // up beside it. It gets the viewport; every other view keeps the shell.
        fullBleedViews={FULL_BLEED_VIEWS}
      />
      <SpawnDialog facade={facade} />
    </>
  );
}

function Root() {
  if (useMock) {
    // No facade prop at all: that takes the snapshot's ORIGINAL path — it
    // builds its own seeded world, derives its own space id, and keeps the
    // simulation driver. Passing the mock in explicitly would work but would
    // silently drop the simulation control, so the default is used on purpose.
    return (
      <CollabV2App
        banner={<ModeBanner mode="mock" detail="seeded in-memory world — nothing here is persisted" />}
      />
    );
  }
  return <RealApp facade={createRealFacade()} />;
}

createRoot(document.getElementById('collab-v2-root') as HTMLElement).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
