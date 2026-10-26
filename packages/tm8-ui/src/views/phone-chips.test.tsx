// @vitest-environment jsdom
/**
 * t-chips — EVERY ENTITY CHIP ON THE PHONE PUSHES THAT ENTITY'S PAGE
 * (CONTRACT §4 ruling, 2026-10-18). No peek sheet: a transcript chip, a
 * created-here row and a ref inside a panel all go through
 * `openEntityOnPhone`, one push, so Back is the page you tapped from.
 * The desktop keeps its aux column.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { GateApp } from './GateApp';
import { MobileShell } from './MobileShell';
import { useGateData, type GateData } from './useGateData';
import { withEntityKind } from './openEntityOnPhone';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { resetNav } from '../stores/navStore';
import { screenStackStore } from '../stores/screenStackStore';
import { createMemoryTarget } from '../routes';
import { SHELL_OVERRIDE_KEY } from '../mobile';
import { FIXTURE_SPACE_ID } from '../fixtures';
import type { MenuTarget } from '../shell';
import type { DetailReasons } from '../panels';

vi.mock('../shell/desktop-modes', () => ({ desktopModes: () => 'legacy' }));

/* The chat surface is stubbed down to ONE chip wired to the verb the shell
   hands it — the same `onOpenEntity` every transcript chip, created-here row
   and `about` chip receives through `ChatHomeScreen`. */
const CHIP_ID = { current: '' };
vi.mock('../chat-home/ChatHomeSurface', () => ({
  ChatHomeSurface: (props: { onOpenEntity?: (id: EntityId) => void }) =>
    props.onOpenEntity ? (
      <button type="button" data-testid="stub-chip" onClick={() => props.onOpenEntity!(CHIP_ID.current as EntityId)}>
        chip
      </button>
    ) : (
      <span data-testid="stub-chip-inert" />
    ),
}));

const SLOW = 30_000;
const SPACE = FIXTURE_SPACE_ID;
const A = 'task-4f8c2a9e' as EntityId;
const PEER = 'task-blocked';
const entityHash = (id: string) => `#/s/${SPACE}/e/${id}?origin=tasks`;

const REASONS: DetailReasons = {
  presenceHollow: 'x',
  versionHistory: 'x',
  provenanceHollow: 'x',
  shareUnavailable: 'x',
  withdrawUnavailable: 'x',
};

/** `router-mount.test.tsx`'s storage double — this runner's `localStorage`
    arrives without `setItem`, and the shell override is read through it. */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const store = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  Object.defineProperty(window, 'localStorage', { configurable: true, value: store });
  return map;
}

function useMobileShell(storage: Map<string, string>): void {
  storage.set(SHELL_OVERRIDE_KEY, 'mobile');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('coarse'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

/**
 * Put the app back on a desktop, COHERENTLY.
 *
 * Clearing the override is not enough and the reason is worth stating, because
 * it cost this file a red: `shellFor` falls back to the VIEWPORT when there is
 * no override, and `beforeEach` has already pinned `innerWidth` to 390 with a
 * coarse pointer for the whole file. An "unset the override" desktop case
 * therefore resolves to mobile again and asserts the phone arrangement while
 * claiming to assert the desktop one — green, and measuring the wrong shell.
 * Both halves are set so the environment agrees with itself.
 */
function useDesktopShell(storage: Map<string, string>): void {
  storage.set(SHELL_OVERRIDE_KEY, 'desktop');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}


beforeEach(() => {
  const storage = installStorage();
  useMobileShell(storage);
  window.location.hash = '';
  resetNav();
  screenStackStore.getState().clearAll();
});
afterEach(cleanup);

describe('withEntityKind — the kind is held or read, never guessed', () => {
  it('opens at once with a kind the gate holds, without a read', () => {
    const open = vi.fn();
    const read = vi.fn();
    withEntityKind('t1' as EntityId, () => 'task', read, open);
    expect(open).toHaveBeenCalledWith('t1', 'task');
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the kind when the gate does not hold the entity', async () => {
    const open = vi.fn();
    withEntityKind('m1' as EntityId, () => undefined, async () => ({ kind: 'message' }), open);
    await waitFor(() => expect(open).toHaveBeenCalledWith('m1', 'message'));
  });

  it('opens nothing when the read fails', async () => {
    const open = vi.fn();
    withEntityKind('gone' as EntityId, () => undefined, () => Promise.reject(new Error('404')), open);
    await new Promise((r) => setTimeout(r, 0));
    expect(open).not.toHaveBeenCalled();
  });
});

function PhoneChat({ navigateTo }: { navigateTo: (t: MenuTarget, o?: { open?: EntityId }) => void }) {
  const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: createFixtureSeam() });
  return (
    <MobileShell
      data={data as GateData & { pull?: (id: string) => void }}
      spaceId={(data.spaceId ?? SPACE) as SpaceId}
      activeTarget={{ type: 'view', ref: 'dashboard' }}
      navigateTo={navigateTo}
      openEntity={null}
      reasons={REASONS}
      onNotice={() => {}}
      nodeKey="local"
    />
  );
}

describe('a chat chip on the phone pushes the entity page', () => {
  it('a task chip is one push of the task page', async () => {
    CHIP_ID.current = A;
    const navigateTo = vi.fn();
    const view = render(<PhoneChat navigateTo={navigateTo} />);
    const chip = await view.findByTestId('stub-chip', undefined, { timeout: SLOW });
    fireEvent.click(chip);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledTimes(1));
    expect(navigateTo).toHaveBeenCalledWith({ type: 'kind', ref: 'task' }, { open: A });
  }, SLOW);
});

/** Open task A on the phone and its Connections sheet from the FAB. */
async function openConnectionsSheet(target: ReturnType<typeof createMemoryTarget>) {
  const view = render(<GateApp routerTarget={target} />);
  const fab = await waitFor(() => {
    const found = document.querySelector('[data-testid="entity-fab"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  }, { timeout: SLOW });
  await act(async () => fireEvent.click(fab));
  const item = await waitFor(() => {
    const found = document.querySelector('[data-fab-item="connections"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  await act(async () => fireEvent.click(item));
  return view;
}

function peerChip(): HTMLElement {
  const chip = document.querySelector(`[data-peer-id="${PEER}"] button.kit-chip`);
  expect(chip).not.toBeNull();
  return chip as HTMLElement;
}

describe('a ref inside a phone panel pushes its page, not the aux peek', () => {
  it('pushes the linked page, drops the sheet, and Back returns to the task', async () => {
    const target = createMemoryTarget(entityHash(A));
    const view = await openConnectionsSheet(target);
    const chip = await waitFor(peerChip);
    await act(async () => fireEvent.click(chip));

    await waitFor(() => expect(target.getHash()).toContain(`/e/${PEER}`));
    expect(target.index).toBe(1);
    expect(document.querySelector('[data-testid="entity-view-aux-sheet"]')).toBeNull();

    await act(async () => target.back());
    await waitFor(() => expect(target.getHash()).toContain(`/e/${A}`));
    view.unmount();
  }, SLOW);

  it('the desktop keeps the aux column and does not navigate', async () => {
    useDesktopShell(installStorage());
    const target = createMemoryTarget(entityHash(A));
    const view = render(<GateApp routerTarget={target} />);
    const tab = await waitFor(() => {
      const found = document.querySelector('#tab-connections');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    }, { timeout: SLOW });
    await act(async () => fireEvent.click(tab));
    const chip = await waitFor(peerChip);
    await act(async () => fireEvent.click(chip));

    /* The column's crumb names the peer: the aux now holds the ENTITY, not
       the Connections tab it was tapped from. */
    await waitFor(() =>
      expect(document.querySelector('.ev-aux__crumb')?.textContent).toBe('Wire palette to real command registry'),
    );
    expect(target.entries).toHaveLength(1);
    view.unmount();
  }, SLOW);
});
