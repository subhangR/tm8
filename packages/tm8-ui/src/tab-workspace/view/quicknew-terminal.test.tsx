// @vitest-environment jsdom
/**
 * THE NEW-CHAT TILE'S TERMINAL ASKS WHICH PROJECT (task 01a159fa).
 *
 * Bhargav (19 Oct): projects need a working folder, and terminals should start
 * from it. Subhang (20 Oct): "only terminal asks for the project". The tile's
 * third cell opens a menu of the Space's projects, with each one's folder,
 * plus Scratch. A pick starts the shell in that project; an untrusted project
 * is drawn refused with its reason, since the node would refuse it anyway.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dispatch = vi.fn();
vi.mock('./context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context')>()),
  useWorkspace: () => ({ dispatch }),
}));

import { QuickNew, type TerminalProjectOption } from './Browser';

afterEach(() => {
  cleanup();
  dispatch.mockReset();
});

const PROJECTS: TerminalProjectOption[] = [
  { id: 'pj-api', name: 'api', trusted: true, detail: 'trusted · /home/me/api' },
  { id: 'pj-old', name: 'legacy', trusted: false, detail: '', reason: "untrusted — can't host sessions · trust it in Node settings" },
];

describe('the New chat · task · terminal · doc · drawing tile', () => {
  it('is five icon-only cells: chat · task · terminal · doc · drawing, each named', () => {
    render(<QuickNew terminal={{ start: vi.fn(), projects: PROJECTS }} />);
    const cells = [...screen.getByTestId('tws-quicknew').querySelectorAll('button')];
    expect(cells.map((b) => b.getAttribute('data-kind'))).toEqual(['chat', 'task', 'terminal', 'doc', 'drawing']);
    expect(cells.map((b) => b.getAttribute('aria-label'))).toEqual(['New chat', 'New task', 'New terminal', 'New doc', 'New drawing']);
    for (const cell of cells) {
      expect(cell.textContent).toBe('');
      expect(cell.querySelector('svg')).not.toBeNull();
      expect(cell.getAttribute('title')).toBeTruthy();
    }
  });

  it('doc and drawing open their drafts directly', () => {
    render(<QuickNew terminal={{ start: vi.fn(), projects: PROJECTS }} />);
    fireEvent.click(screen.getByTestId('tws-quicknew-doc'));
    fireEvent.click(screen.getByTestId('tws-quicknew-drawing'));
    expect(dispatch).toHaveBeenNthCalledWith(1, { command: 'workspace.drafts.open', args: { kind: 'doc' }, source: 'click' });
    expect(dispatch).toHaveBeenNthCalledWith(2, { command: 'workspace.drafts.open', args: { kind: 'drawing' }, source: 'click' });
  });

  it('New chat opens the chat draft directly, with no project question', () => {
    render(<QuickNew terminal={{ start: vi.fn(), projects: PROJECTS }} />);
    fireEvent.click(screen.getByTestId('tws-quicknew-chat'));
    expect(dispatch).toHaveBeenCalledWith({ command: 'workspace.drafts.open', args: { kind: 'chat' }, source: 'click' });
    expect(screen.queryByTestId('tws-quicknew-terminal-menu')).toBeNull();
  });

  it('Terminal asks for the project, shows its folder, and starts in the pick', () => {
    const start = vi.fn();
    render(<QuickNew terminal={{ start, projects: PROJECTS }} />);
    fireEvent.click(screen.getByTestId('tws-quicknew-terminal'));
    expect(start).not.toHaveBeenCalled();
    const menu = screen.getByTestId('tws-quicknew-terminal-menu');
    expect(menu.textContent).toContain('/home/me/api');
    fireEvent.click(screen.getByTestId('tws-quicknew-terminal-pj-api'));
    expect(start).toHaveBeenCalledWith('pj-api');
    expect(screen.queryByTestId('tws-quicknew-terminal-menu')).toBeNull();
  });

  it('Scratch starts a projectless terminal', () => {
    const start = vi.fn();
    render(<QuickNew terminal={{ start, projects: PROJECTS }} />);
    fireEvent.click(screen.getByTestId('tws-quicknew-terminal'));
    fireEvent.click(screen.getByTestId('tws-quicknew-terminal-scratch'));
    expect(start).toHaveBeenCalledWith(null);
  });

  it('an untrusted project is refused with its reason, not started', () => {
    const start = vi.fn();
    render(<QuickNew terminal={{ start, projects: PROJECTS }} />);
    fireEvent.click(screen.getByTestId('tws-quicknew-terminal'));
    const legacy = screen.getByTestId('tws-quicknew-terminal-pj-old');
    expect(legacy.getAttribute('aria-disabled')).toBe('true');
    expect(legacy.textContent).toContain('untrusted');
    fireEvent.click(legacy);
    expect(start).not.toHaveBeenCalled();
  });

  it('with no node to start on, Terminal is refused with the reason and opens nothing', () => {
    render(<QuickNew terminal={{ projects: PROJECTS }} />);
    const cell = screen.getByTestId('tws-quicknew-terminal');
    expect(cell.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(cell);
    expect(screen.queryByTestId('tws-quicknew-terminal-menu')).toBeNull();
  });
});
