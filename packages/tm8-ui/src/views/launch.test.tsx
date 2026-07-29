// @vitest-environment jsdom
/**
 * Launch sheet — the D44/D51 anatomy and, more importantly, the THREE
 * OBLIGATIONS that ride with hosting it (A1a's findings).
 *
 * Two of those obligations fail SILENTLY when they are wrong: Esc quietly pops
 * the panel underneath, and an orphaned sheet keeps configuring a launch for a
 * panel that closed. Neither shows up in a test that does not open a sheet
 * first, which is exactly why they are pinned here.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { LaunchSheet } from './LaunchSheet';
import { useLaunchSheet } from './useLaunchSheet';
import { PanelStack } from '../shell/PanelStack';
import type { NavPort } from '../shell/nav-port';
import { teamMemberForge } from '../fixtures';
import { LAUNCH_CAPACITY, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_TEAMMATES } from './launch-fixtures';

const renderSheet = (props: Partial<React.ComponentProps<typeof LaunchSheet>> = {}) =>
  render(
    <div className="cv2-root">
      <LaunchSheet
        subjectId={'task-1' as EntityId}
        fromChip="◔ Run ▸"
        fromCaption="task pre-associated"
        teammates={LAUNCH_TEAMMATES}
        projects={LAUNCH_PROJECTS}
        profiles={LAUNCH_PROFILES}
        capacity={LAUNCH_CAPACITY}
        onLaunch={() => {}}
        onCancel={() => {}}
        {...props}
      />
    </div>,
  );

describe('OBLIGATION 1 — Esc must not pop the panel under an open sheet', () => {
  const makeNav = (stack: string[]): NavPort & { popped: number } => {
    const port = {
      stack: stack as EntityId[],
      pinned: [] as EntityId[],
      popped: 0,
      push: () => {},
      pop() { port.popped += 1; },
      close: () => {},
      pin: () => ({ ok: true as const }),
      unpin: () => {},
      promote: () => {},
      applyNormalization: () => {},
    };
    return port;
  };

  it('pops normally when NO modal is declared', () => {
    const nav = makeNav(['a']);
    render(<PanelStack nav={nav} renderPanel={(id) => <span>{id}</span>} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.popped).toBe(1); // control: the listener works at all
  });

  it('does NOT pop when the sheet declares itself modal', () => {
    // Without this guard the viewer presses Esc to dismiss a launch they were
    // configuring and silently loses the panel behind it — the "Esc is broken"
    // shape. The keyboard contract cannot detect an UNDECLARED modal.
    const nav = makeNav(['a']);
    render(
      <PanelStack nav={nav} renderPanel={(id) => <span>{id}</span>} isKeyboardOwnedAbove={() => true} />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(nav.popped).toBe(0);
  });
});

describe('OBLIGATION 2 — the sheet never outlives its subject', () => {
  it('clears when the subject stops being hosted', () => {
    const { result, rerender } = renderHook(
      ({ hosted }: { hosted: EntityId[] }) => useLaunchSheet({ hostedIds: hosted }),
      { initialProps: { hosted: ['t1'] as EntityId[] } },
    );
    result.current.open('t1' as EntityId);
    rerender({ hosted: ['t1'] as EntityId[] });
    expect(result.current.subjectId).toBe('t1');

    // The subject leaves — by ANY route: pop, close, promote, or a hydration
    // nobody dispatched. Keying on membership covers all of them.
    rerender({ hosted: [] as EntityId[] });
    expect(result.current.subjectId).toBeNull();
  });

  it('reports modal-open only while a subject is set', () => {
    const { result, rerender } = renderHook(
      ({ hosted }: { hosted: EntityId[] }) => useLaunchSheet({ hostedIds: hosted }),
      { initialProps: { hosted: ['t1'] as EntityId[] } },
    );
    expect(result.current.isModalOpen()).toBe(false);
    result.current.open('t1' as EntityId);
    rerender({ hosted: ['t1'] as EntityId[] });
    expect(result.current.isModalOpen()).toBe(true);
  });

  it('declares modalDepth to a real keyboard controller when one is installed', () => {
    const setKeyboardContext = vi.fn();
    const { result, rerender } = renderHook(() =>
      useLaunchSheet({ hostedIds: ['t1'] as EntityId[], setKeyboardContext }),
    );
    result.current.open('t1' as EntityId);
    expect(setKeyboardContext).toHaveBeenCalledWith({ modalDepth: 1 });
    rerender();
    result.current.close();
    expect(setKeyboardContext).toHaveBeenLastCalledWith({ modalDepth: 0 });
  });
});

describe('ESC — both halves, which is the point', () => {
  it('CLOSES the sheet, and does NOT pop the panel behind it', () => {
    // The prevention half was built and tested; the ACTING half was not, so
    // Escape was swallowed while the header said "esc closes". One test pins
    // both: dismissal happens AND the fall-through stays prevented. Neither
    // half can regress without failing here.
    const onCancel = vi.fn();
    const nav = {
      stack: ['behind'] as EntityId[],
      pinned: [] as EntityId[],
      popped: 0,
      push: () => {},
      pop() { (nav as { popped: number }).popped += 1; },
      close: () => {},
      pin: () => ({ ok: true as const }),
      unpin: () => {},
      promote: () => {},
      applyNormalization: () => {},
    };
    render(
      <div className="cv2-root">
        <PanelStack nav={nav} renderPanel={(id) => <span>{id}</span>} isKeyboardOwnedAbove={() => true} />
        <LaunchSheet
          subjectId={'task-1' as EntityId}
          fromChip="◔ Run ▸"
          fromCaption="ctx"
          teammates={LAUNCH_TEAMMATES}
          projects={LAUNCH_PROJECTS}
          profiles={LAUNCH_PROFILES}
          capacity={LAUNCH_CAPACITY}
          onLaunch={() => {}}
          onCancel={onCancel}
        />
      </div>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);  // the ACTING half
    expect(nav.popped).toBe(0);                 // the PREVENTING half
  });

  it('the header does not advertise a dismissal the sheet lacks', () => {
    // The defect was discoverable from the copy alone: the header said
    // "esc closes" while nothing listened.
    const onCancel = vi.fn();
    const { container } = renderSheet({ onCancel });
    expect(container.textContent).toContain('esc closes');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('the sheet anatomy (T5-5 / D51)', () => {
  it('renders the complete launch configuration with an explicit model control', () => {
    const { container, getByTestId } = renderSheet();
    const eyebrows = [...container.querySelectorAll('.ls__eyebrow')].map((n) => n.textContent);
    expect(eyebrows).toContain('TEAMMATE');
    expect(eyebrows).toContain('WORKING DIRECTORY');
    expect(eyebrows).toContain('INTERACTION PROFILE');
    // Model stays within the teammate section, but is a real selectable input.
    expect(eyebrows).not.toContain('MODEL');
    expect(container.textContent).toContain('claude-sonnet-5 · claude-code · owned by @ada');
    expect(getByTestId('launch-model')).toBeInstanceOf(HTMLSelectElement);
  });

  it('renders the untrusted project DISABLED-WITH-REASON and still reachable (L6/D28)', () => {
    const { getByTitle } = renderSheet();
    const row = getByTitle("untrusted — can't host sessions · trust it in Node settings ↗");
    expect(row.getAttribute('aria-disabled')).toBe('true');
    // Never natively disabled: a reason you cannot focus is no reason at all.
    expect((row as HTMLButtonElement).disabled).toBe(false);
    row.focus();
    expect(document.activeElement).toBe(row);
  });

  it('refuses draft and retired profiles with a reason naming the mechanism (D51)', () => {
    const { getByText, container } = renderSheet();
    fireEvent.click(getByText('change ▾'));
    const picker = container.querySelector('.ls__picker') as HTMLElement;
    const refused = [...picker.querySelectorAll('[aria-disabled="true"]')];
    expect(refused).toHaveLength(2); // the draft and the retired one
    expect(within(picker).getByText(/draft — not activated yet/)).toBeTruthy();
    expect(within(picker).getByText(/retired — kept for sessions already pinned/)).toBeTruthy();
  });

  it('shows the resolution chain with BRASS on the winner (D51 + D53)', () => {
    const { container } = renderSheet();
    const won = container.querySelectorAll('.ls__step--won');
    expect(won).toHaveLength(1);
    // forge carries a default, so the teammate step wins over space/server.
    expect(won[0]?.textContent).toBe('teammate default');
    expect(container.textContent).toContain("resolved from forge's default");
  });

  it('states the pinned-forever law BEFORE the commit control (T2-4 / D51)', () => {
    const { container } = renderSheet();
    const pinned = container.querySelector('.ls__pinned') as HTMLElement;
    const launch = container.querySelector('.ls__launch') as HTMLElement;
    expect(pinned.textContent).toContain('pinned at launch — immutable');
    // DOM order is the guarantee: the caption is read before the button is
    // reached, which is the whole point of "the caption says so before you
    // commit".
    expect(pinned.compareDocumentPosition(launch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders a refusal IN the sheet, not as a toast (T5-5)', () => {
    const { getByRole } = renderSheet({
      refusal: { cause: 'spawn refused — no free slots', detail: 'Nothing was started; your picks are kept right here.' },
    });
    const alert = getByRole('alert');
    expect(alert.textContent).toContain('spawn refused — no free slots');
    expect(alert.textContent).toContain('Nothing was started');
  });

  it('states node capacity before commitment', () => {
    const { container } = renderSheet();
    expect(container.querySelector('.ls__capacity')?.textContent).toContain('8 slots, 3 in use');
  });

  it('submits one typed working-directory target and the full tool configuration', () => {
    const onLaunch = vi.fn();
    const { getByText } = renderSheet({ onLaunch });
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch).toHaveBeenCalledWith(
      // Asserted against the ENTITY FIXTURE's own id, not a literal (A1c's
      // stronger version). A literal agrees with whatever the view-model holds
      // and with the seam never — it pins internal consistency rather than the
      // thing that has to be true, which is that the id RESOLVES. Coupled this
      // way, a future rename fails here instead of silently re-breaking spawn.
      expect.objectContaining({
        subjectId: 'task-1',
        teamMemberId: teamMemberForge.id,
        target: { kind: 'project', projectId: 'pj-tm8ui' },
        agentToolId: 'claude-code',
        model: 'claude-sonnet-5',
        mode: 'worker',
      }),
    );
  });

  it('exposes and submits a concrete model choice in Full Options', () => {
    const onLaunch = vi.fn();
    const { getByTestId, getByText } = renderSheet({ onLaunch });
    fireEvent.change(getByTestId('launch-model'), { target: { value: 'claude-opus-5' } });
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({
      agentToolId: 'claude-code',
      model: 'claude-opus-5',
      target: { kind: 'project', projectId: 'pj-tm8ui' },
    }));
  });

  it('sends only an explicit active profile selection', () => {
    const onLaunch = vi.fn();
    const { getByText } = renderSheet({ onLaunch });
    fireEvent.click(getByText('change ▾'));
    fireEvent.click(getByText('house-style'));
    fireEvent.click(getByText('Launch ▸'));
    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ interactionProfileId: 'pf-house' }),
    );
  });

});
