/**
 * Z1 chip + Z2 card behavior: per-kind rendering, hover → shared popover
 * (delay/cancel), click → panel push, drag payload, badges, skeletons.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EntityCard, EntityChip, ENTITY_DRAG_MIME, EntityCardSkeleton,
} from '../../entity';
import { registryFor } from '../../registry';
import { useNavStore } from '../../stores';
import type { EntityDetail, EntityKind } from '../../types/contract';
import { ALL_KINDS, createFacade, loadKindDetails, renderWith, resetStores } from './helpers';
import type { MockFacade } from '../../mock';

let facade: MockFacade;
let details: Record<EntityKind, EntityDetail>;

beforeAll(async () => {
  facade = createFacade();
  details = await loadKindDetails(facade);
});

beforeEach(() => resetStores());

describe('EntityChip (Z1)', () => {
  it.each(ALL_KINDS)('%s renders glyph + registry label', (kind) => {
    const detail = details[kind];
    const entry = registryFor(kind);
    const { getByRole, unmount } = renderWith(facade, <EntityChip entity={detail} />);
    const chip = getByRole('button');
    expect(chip.getAttribute('data-kind')).toBe(kind);
    expect(chip.textContent).toContain(entry.chipLabel(detail));
    unmount();
  });

  it('click pushes a Z3 panel onto the nav stack', () => {
    const { getByRole, unmount } = renderWith(facade, <EntityChip entity={details.task} />);
    fireEvent.click(getByRole('button'));
    expect(useNavStore.getState().stack.map((r) => r.entityId)).toContain(details.task.id);
    unmount();
  });

  it('hover opens the shared Z2 popover after the delay; leave cancels it', () => {
    vi.useFakeTimers();
    try {
      const { getByRole, unmount } = renderWith(facade, <EntityChip entity={details.doc} />);
      const chip = getByRole('button');

      fireEvent.mouseEnter(chip);
      expect(screen.queryByRole('tooltip')).toBeNull(); // not yet — delay pending
      act(() => { vi.advanceTimersByTime(400); });
      const pop = screen.getByRole('tooltip');
      expect(pop.textContent).toContain(details.doc.title); // Z2 card inside

      fireEvent.mouseLeave(chip);
      act(() => { vi.advanceTimersByTime(300); });
      expect(screen.queryByRole('tooltip')).toBeNull();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hover then early leave never opens (cancel beats the delay)', () => {
    vi.useFakeTimers();
    try {
      const { getByRole, unmount } = renderWith(facade, <EntityChip entity={details.task} />);
      const chip = getByRole('button');
      fireEvent.mouseEnter(chip);
      act(() => { vi.advanceTimersByTime(100); });
      fireEvent.mouseLeave(chip);
      act(() => { vi.advanceTimersByTime(1000); });
      expect(screen.queryByRole('tooltip')).toBeNull();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drag start writes the entity-ref payload', () => {
    const data: Record<string, string> = {};
    const dataTransfer = {
      setData: (type: string, value: string) => { data[type] = value; },
      effectAllowed: '',
    };
    const { getByRole, unmount } = renderWith(facade, <EntityChip entity={details.task} />);
    fireEvent.dragStart(getByRole('button'), { dataTransfer });
    const payload = JSON.parse(data[ENTITY_DRAG_MIME]);
    expect(payload).toMatchObject({ entityId: details.task.id, kind: 'task' });
    expect(data['text/plain']).toBeTruthy();
    unmount();
  });
});

describe('EntityCard (Z2)', () => {
  it.each(ALL_KINDS)('%s renders title, kind eyebrow, and universal footer', (kind) => {
    const detail = details[kind];
    const entry = registryFor(kind);
    const { container, unmount } = renderWith(facade, <EntityCard entity={detail} />);
    expect(container.querySelector('.cv2-card')?.getAttribute('data-kind')).toBe(kind);
    expect(container.querySelector('.cv2-card__title')?.textContent).toBe(detail.title);
    expect(container.querySelector('.cv2-card__kind')?.textContent).toBe(entry.label);
    // universal footer: likes · stars · points · messages always present
    const counts = [...container.querySelectorAll('.cv2-card__foot .cv2-count')].map((n) => n.textContent);
    expect(counts.join(' ')).toContain(String(detail.counters.likes));
    unmount();
  });

  it('shows the blocked ⚠ badge for a task waiting on hard deps (seed T-105)', async () => {
    const blocked = await facade.getEntity(facade.ids.t105);
    expect(blocked.badges.blocked).toBeTruthy(); // seed invariant this test rides on
    const { container, unmount } = renderWith(facade, <EntityCard entity={blocked} />);
    expect(container.querySelector('.cv2-card__badges')?.textContent).toContain('blocked');
    unmount();
  });

  it('shows the stale-pin badge when a pull is content-stale', () => {
    const doc = details.doc;
    const stale = {
      ...doc,
      badges: {
        ...doc.badges,
        pulls: [{
          actor: doc.createdBy, localId: null, pinnedVersion: doc.version - 1,
          contentStale: true, discussionMoved: false, workStatus: null,
          pulledAt: doc.createdAt,
        }],
      },
    };
    const { container, unmount } = renderWith(facade, <EntityCard entity={stale} />);
    expect(container.querySelector('.cv2-card__badges')?.textContent).toContain('stale');
    unmount();
  });

  it('renders key edge chips in the footer when provided', () => {
    const { container, unmount } = renderWith(
      facade,
      <EntityCard entity={details.task} keyEdges={[details.doc, details.channel]} />,
    );
    expect(container.querySelectorAll('.cv2-card__edges .cv2-chip').length).toBe(2);
    unmount();
  });

  it('has a skeleton variant', () => {
    const { container, unmount } = renderWith(facade, <EntityCardSkeleton />);
    expect(container.querySelector('[data-skeleton="card"]')).toBeTruthy();
    unmount();
  });

  it('waits for nothing: a tombstoned summary renders as a tombstone card', async () => {
    const created = await facade.createTask({ spaceId: facade.ids.space, title: 'Doomed', parentId: null });
    const res = await facade.deleteEntity(created.entity!.id);
    const dead = res.patches.find((p) => p.id === created.entity!.id && p.deletedAt != null);
    expect(dead).toBeTruthy();
    const { container, unmount } = renderWith(facade, <EntityCard entity={dead!} />);
    await waitFor(() => {
      expect(container.querySelector('.cv2-card--tombstone')).toBeTruthy();
    });
    unmount();
  });
});
