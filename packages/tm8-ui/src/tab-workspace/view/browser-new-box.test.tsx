// @vitest-environment jsdom
/**
 * The Work browser's dotted new box (design log R44): a bold + that creates
 * the current kind, then that kind's icon + ▾ opening the kind menu. The +
 * keeps "Create <noun>" as its name and "New <noun>" as its tooltip; a kind
 * that cannot be created mutes the + and shows the reason instead.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getKind } from '../../domain';
import { ListRootHeader } from '../../panels/ListRootHeader';
import { NewBox } from './Browser';

afterEach(cleanup);

type Opts = { disabledReason?: string | null; onPickKind?: (k: string) => void; onCreate?: () => void };

function box(kind: string, opts: Opts = {}) {
  const config = getKind(kind);
  const cell = { kind, label: config.labelPlural, single: config.label };
  const options = ['task', 'doc'].map((k) => ({ kind: k, label: getKind(k).labelPlural, single: getKind(k).label }));
  const ui = (
    <NewBox
      noun={config.label.toLowerCase()}
      disabledReason={opts.disabledReason ?? null}
      onCreate={opts.onCreate ?? (() => undefined)}
      header={
        <ListRootHeader
          rootsLabel="Work browser"
          kindMenuLabel={`${cell.label} — change kind`}
          kindMenuIconOnly
          cell={cell}
          cellActive
          onSelectCell={() => undefined}
          options={options}
          currentKind={kind}
          onPickKind={opts.onPickKind ?? (() => undefined)}
        />
      }
    />
  );
  return ui;
}

function renderBox(kind: string, opts: Opts = {}) {
  const onCreate = vi.fn();
  return { onCreate, ...render(box(kind, { onCreate, ...opts })) };
}

const kindTrigger = () => screen.getByRole('button', { name: /change kind$/ });
const kindArt = () => kindTrigger().querySelector('.tch-rootcell__glyph')!.innerHTML;

describe('Work browser new box', () => {
  it('draws a bold + and the current kind icon, named Create <noun> with a New <noun> tooltip', () => {
    const { onCreate } = renderBox('task');
    const plus = screen.getByTestId('tws-browser-new');
    expect(plus.getAttribute('aria-label')).toBe('Create task');
    expect(plus.getAttribute('title')).toBe('New task');
    expect(plus.querySelector('svg.tws-browser-new__glyph path')).not.toBeNull();
    expect(plus.textContent).toBe('');
    expect(kindTrigger().getAttribute('data-kind')).toBe('task');
    expect(kindTrigger().querySelector('.tch-rootcell__glyph svg')).not.toBeNull();
    fireEvent.click(plus);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('fires one ripple per create', () => {
    const { container } = renderBox('task');
    expect(container.querySelector('.tws-browser-new__ripple')).toBeNull();
    fireEvent.click(screen.getByTestId('tws-browser-new'));
    expect(container.querySelectorAll('.tws-browser-new__ripple')).toHaveLength(1);
  });

  it('mutes the + with the disabled reason when the kind is not creatable', () => {
    const { onCreate, container } = renderBox('task', { disabledReason: 'Tasks are created elsewhere' });
    const plus = screen.getByTestId('tws-browser-new');
    expect(plus.getAttribute('aria-disabled')).toBe('true');
    expect(plus.getAttribute('title')).toBe('Tasks are created elsewhere');
    expect(screen.getByTestId('tws-browser-newbox').hasAttribute('data-disabled')).toBe(true);
    fireEvent.click(plus);
    expect(onCreate).not.toHaveBeenCalled();
    expect(container.querySelector('.tws-browser-new__ripple')).toBeNull();
    /* The kind menu still opens: a non-creatable kind is still browsable. */
    fireEvent.click(kindTrigger());
    expect(screen.getByRole('menu', { name: 'Entity lists' })).toBeTruthy();
  });

  it('opens the kind menu from the icon, and a new kind swaps the icon and the noun', () => {
    const onPickKind = vi.fn();
    const { rerender } = renderBox('task', { onPickKind });
    const taskArt = kindArt();
    fireEvent.click(kindTrigger());
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Docs/ }));
    expect(onPickKind).toHaveBeenCalledWith('doc');

    /* The Browser re-renders the box with the kind the pick set. */
    rerender(box('doc', { onPickKind }));
    expect(kindTrigger().getAttribute('data-kind')).toBe('doc');
    expect(kindArt()).not.toBe(taskArt);
    expect(screen.getByTestId('tws-browser-new').getAttribute('aria-label')).toBe('Create doc');
  });
});
