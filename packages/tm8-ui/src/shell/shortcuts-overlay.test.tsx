// @vitest-environment jsdom
/**
 * The `?` overlay and the palette's shortcut hints (task 01a113aa): both are
 * read from the keyboard contract, and neither advertises a key that does
 * nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { CommandPalette } from './CommandPalette';
import { ShortcutsOverlay, helpRows, keyCaps } from './ShortcutsOverlay';

describe('ShortcutsOverlay', () => {
  it('lists the Workspace shortcuts, leaving the field first', () => {
    const { getAllByTestId, getByRole } = render(<ShortcutsOverlay open onClose={() => {}} />);
    const ids = getAllByTestId('shortcut-row').map((row) => row.getAttribute('data-binding'));
    for (const id of ['text.blur', 'terminal.toggle', 'l.focus', 'l.task', 'n.task', 'n.drawing', 'work.tab.close', 'work.tab.1', 'work.design', 't.links', 'list.launch', 'help.open']) {
      expect(ids, id).toContain(id);
    }
    // The first section is about getting out of a field.
    expect(getByRole('dialog').querySelector('.pal__group')?.textContent).toBe('FOCUS');
  });

  it('does not advertise the focus-layer keys the shell never fires', () => {
    const ids = helpRows('mac').flatMap((s) => s.rows.map((b) => b.id));
    expect(ids).not.toContain('panel.pin');
    expect(ids).not.toContain('list.search');
    expect(ids).not.toContain('panel.pop');
  });

  it('hides Mod+K where the browser owns it', () => {
    const other = helpRows('other').flatMap((s) => s.rows.map((b) => b.id));
    expect(other).not.toContain('palette.mod-k');
    expect(helpRows('mac').flatMap((s) => s.rows.map((b) => b.id))).toContain('palette.mod-k');
  });

  it('draws key caps per platform', () => {
    expect(keyCaps('Mod+Alt+W', 'mac')).toEqual(['⌘', '⌥', 'W']);
    expect(keyCaps('Mod+Alt+W', 'other')).toEqual(['Ctrl', 'Alt', 'W']);
    expect(keyCaps('n t', 'mac')).toEqual(['n', 't']);
    expect(keyCaps('Ctrl+]', 'mac')).toEqual(['Ctrl', ']']);
  });

  it('filters, and Esc closes it', () => {
    const onClose = vi.fn();
    const { getByLabelText, getAllByTestId } = render(<ShortcutsOverlay open onClose={onClose} />);
    fireEvent.change(getByLabelText('Filter keyboard shortcuts'), { target: { value: 'new task' } });
    expect(getAllByTestId('shortcut-row').map((r) => r.getAttribute('data-binding'))).toEqual(['n.task']);
    fireEvent.keyDown(getByLabelText('Filter keyboard shortcuts'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('palette shortcut hints', () => {
  it('shows a view row’s shortcut as key caps', () => {
    const { getAllByTestId } = render(
      <CommandPalette
        open
        results={[]}
        views={[
          { id: 'kind:task', label: 'Tasks', hint: 'g t' },
          { id: 'new:task', label: 'New task', hint: 'n t' },
          { id: 'view:messages', label: 'Messages' },
        ]}
        ctx={{ spaceId: 's' }}
      />,
    );
    const hints = getAllByTestId('palette-row-shortcut').map((el) => el.getAttribute('aria-label'));
    expect(hints).toEqual(['Shortcut g t', 'Shortcut n t']);
  });
});
