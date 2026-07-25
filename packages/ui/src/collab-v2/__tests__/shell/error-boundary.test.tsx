/**
 * The boundary that stops one broken surface from taking the app with it.
 *
 * There was no error boundary anywhere in this package, so a render-time throw
 * unmounted the whole shell and left a white page whose only recovery was a
 * reload. The Settings screen did exactly that against a real server. The screen
 * is fixed, but the FRAGILITY was the real defect — any future screen could do
 * it again — so what is asserted here is containment, not any one screen.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../../kit';
import { ShellLayout } from '../../shell/ShellLayout';
import { createSeededFacade, type MockFacade } from '../../mock';
import { useNavStore } from '../../stores/nav';
import { createMemoryTarget } from '../../shell/router';
import type { ViewRegistry } from '../../shell/types';

function Bomb(): never {
  throw new Error('this screen is broken');
}

let facade: MockFacade;

beforeEach(() => {
  facade = createSeededFacade();
  useNavStore.getState().reset();
  // React logs caught errors; the noise is expected here and only here.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('ErrorBoundary', () => {
  it('renders the children when nothing throws', () => {
    render(<ErrorBoundary label="A surface"><p>fine</p></ErrorBoundary>);
    expect(screen.getByText('fine')).toBeTruthy();
    expect(screen.queryByTestId('error-boundary')).toBeNull();
  });

  it('captions the failure instead of rendering nothing', () => {
    render(<ErrorBoundary label="The settings screen"><Bomb /></ErrorBoundary>);

    // Silence would be worse than the crash: an empty surface is
    // indistinguishable from a legitimately-empty one, and this app has many.
    expect(screen.getByTestId('error-boundary')).toBeTruthy();
    expect(screen.getByText(/The settings screen failed to render/)).toBeTruthy();
    expect(screen.getByText(/this screen is broken/)).toBeTruthy();
  });

  it('clears the error when resetKey changes (navigating away)', () => {
    const { rerender } = render(
      <ErrorBoundary label="X" resetKey="a"><Bomb /></ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary')).toBeTruthy();

    rerender(<ErrorBoundary label="X" resetKey="b"><p>next screen</p></ErrorBoundary>);
    expect(screen.queryByTestId('error-boundary')).toBeNull();
    expect(screen.getByText('next screen')).toBeTruthy();
  });

  it('Try again remounts the subtree', () => {
    let broken = true;
    const Flaky = () => {
      if (broken) throw new Error('transient');
      return <p>recovered</p>;
    };
    render(<ErrorBoundary label="X"><Flaky /></ErrorBoundary>);
    expect(screen.getByTestId('error-boundary')).toBeTruthy();

    broken = false;
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('recovered')).toBeTruthy();
  });
});

describe('a crashing screen does not take the shell with it', () => {
  it('keeps the rails mounted and the app navigable', async () => {
    const views = { home: Bomb } as unknown as ViewRegistry;
    render(
      <ShellLayout
        facade={facade}
        spaceId={facade.ids.space}
        views={views}
        routerTarget={createMemoryTarget(`#/s/${encodeURIComponent(facade.ids.space)}/home`)}
      />,
    );

    // The screen failed...
    expect(await screen.findByTestId('error-boundary')).toBeTruthy();
    // ...and everything around it survived. Before the boundary, this assertion
    // was the one that failed: the whole tree unmounted to a blank page.
    expect(screen.getByTestId('cv2-shell')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Space navigation' })).toBeTruthy();
  });
});
