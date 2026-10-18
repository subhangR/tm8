// @vitest-environment jsdom
/**
 * fu-channel — A CHANNEL FEED CHIP ON THE PHONE PUSHES THE ENTITY PAGE
 * (CONTRACT §4 ruling 1). ChannelView's feed chips used to open the aside
 * beside the feed, a peek on a 390px screen. On the phone they go through
 * `openEntityOnPhone`: one push, so Back is the channel. The desktop keeps
 * the aside.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { ChannelView } from './ChannelView';
import { MobileShell } from './MobileShell';
import { useGateData, type GateData } from './useGateData';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { FIXTURE_SPACE_ID } from '../fixtures';
import type { MenuTarget } from '../shell';
import type { DetailReasons } from '../panels';

/* The feed is stubbed down to ONE chip wired to the verb ChannelView hands
   it: the same `onOpenEntity` every FeedRow ref, mention and context chip gets. */
const CHIP_ID = 'task-4f8c2a9e' as EntityId;
vi.mock('../channel-screen/LazyChannelScreen', () => ({
  LazyChannelScreen: (props: { onOpenEntity?: (id: EntityId) => void }) => (
    <button type="button" data-testid="stub-feed-chip" onClick={() => props.onOpenEntity?.(CHIP_ID)}>
      chip
    </button>
  ),
}));

const SLOW = 30_000;
const CHANNEL = 'ch-design' as EntityId;
const REASONS: DetailReasons = {
  presenceHollow: 'x',
  versionHistory: 'x',
  provenanceHollow: 'x',
  shareUnavailable: 'x',
  withdrawUnavailable: 'x',
};

afterEach(cleanup);

function PhoneChannel({ navigateTo }: { navigateTo: (t: MenuTarget, o?: { open?: EntityId }) => void }) {
  const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: createFixtureSeam() });
  return (
    <MobileShell
      data={data as GateData & { pull?: (id: string) => void }}
      spaceId={(data.spaceId ?? FIXTURE_SPACE_ID) as SpaceId}
      activeTarget={{ type: 'entity', ref: CHANNEL, kind: 'channel' }}
      navigateTo={navigateTo}
      openEntity={null}
      reasons={REASONS}
      onNotice={() => {}}
      nodeKey="local"
    />
  );
}

function DesktopChannel() {
  const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: createFixtureSeam() });
  return <ChannelView data={data} channelId={CHANNEL} reasons={REASONS} />;
}

describe('a channel feed chip', () => {
  it('on the phone is one push of the entity page, with no aside', async () => {
    const navigateTo = vi.fn();
    const view = render(<PhoneChannel navigateTo={navigateTo} />);
    fireEvent.click(await view.findByTestId('stub-feed-chip', undefined, { timeout: SLOW }));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledTimes(1));
    expect(navigateTo).toHaveBeenCalledWith({ type: 'kind', ref: 'task' }, { open: CHIP_ID });
    expect(document.querySelector('.chv-aside')).toBeNull();
  }, SLOW);

  it('on the desktop opens the aside beside the feed, as before', async () => {
    const view = render(<DesktopChannel />);
    fireEvent.click(await view.findByTestId('stub-feed-chip', undefined, { timeout: SLOW }));
    await waitFor(() => expect(document.querySelector('.chv-aside')).not.toBeNull());
  }, SLOW);
});
