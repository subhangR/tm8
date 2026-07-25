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
import { SpacePicker } from './real/SpacePicker';
import { SpawnDialog } from './real/SpawnDialog';
import { installTm8Kinds } from './real/tm8Kinds';

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

  const banner = (
    <ModeBanner mode="real" detail="tm8 catalog over /v2 (proxied)" connected={connected} />
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
