// @vitest-environment jsdom
/**
 * DELETE IN THE WORKSPACE ⋯ MENU FOR A KIND WITH NO CONTROLS. A doc (or a
 * craft) has no chip strip; it still deletes. The embedded danger slot draws
 * the archive verb whenever the host can archive, and `canDelete` alone
 * decides whether it shows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { REASONS as DOMAIN_REASONS, type ActionContext } from '../../domain';
import { FIXTURE_SPACE_ID, fixtureDetails, presenceHollowReason } from '../../fixtures';
import { EntityDetailPanel, type DetailReasons } from '../index';

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const REASONS: DetailReasons = {
  presenceHollow: presenceHollowReason,
  versionHistory: DOMAIN_REASONS.versionHistoryDeferred,
  provenanceHollow: 'Session provenance is not recorded yet.',
  shareUnavailable: 'not in the stamped seam',
  withdrawUnavailable: 'not in the stamped seam',
};
const DOC = Object.values(fixtureDetails).find((d) => d.kind === 'doc' && d.deletedAt == null)!;

function mount(detail: EntityDetail) {
  const danger = document.createElement('div');
  document.body.appendChild(danger);
  const onArchive = vi.fn();
  render(
    <EntityDetailPanel
      detail={detail}
      reasons={REASONS}
      ctx={ctx}
      commands={{ createEntity: vi.fn() }}
      controls={{ kind: detail.kind, ctx, onArchive, capabilitiesOf: () => detail.capabilities }}
      embeddedChrome={{
        verbsSlot: null,
        kindSlot: null,
        commonVerbsSlot: null,
        statsSlot: null,
        menuSlot: null,
        dangerSlot: danger,
        titleSlot: null,
      }}
    />,
  );
  return { danger, onArchive };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('the embedded ⋯ menu of a kind with no controls', () => {
  it('offers Delete when the viewer can delete, and runs the host’s archive', () => {
    const { danger, onArchive } = mount({ ...DOC, capabilities: { ...DOC.capabilities, canDelete: true } });
    const button = danger.querySelector('button');
    expect(button).not.toBeNull();
    fireEvent.click(button!);
    expect(onArchive).toHaveBeenCalledWith('archive', DOC.id);
  });

  it('draws nothing where the server refuses the delete', () => {
    const { danger } = mount({ ...DOC, capabilities: { ...DOC.capabilities, canDelete: false } });
    expect(danger.querySelector('button')).toBeNull();
  });
});
