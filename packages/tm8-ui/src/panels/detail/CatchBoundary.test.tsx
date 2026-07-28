// @vitest-environment jsdom
/**
 * The boundary's fires-red-first record is the FIRST test: rendering a
 * throwing body WITHOUT the boundary crashes the whole render — that crash
 * (caught here as expect(...).toThrow) IS the pre-mechanism state the
 * Surface Audit named. The remaining tests are the mechanism working.
 */
import { render, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CatchBoundary } from './CatchBoundary';

function Bomb({ fuse }: { fuse: boolean }): JSX.Element {
  if (fuse) throw new Error('body exploded');
  return <p>alive</p>;
}

describe('CatchBoundary — the real componentDidCatch', () => {
  it('RED-FIRST RECORD: without the boundary, a throwing body takes the whole render down', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Bomb fuse />)).toThrow('body exploded');
    spy.mockRestore();
  });

  it('with the boundary: the crash renders the designed error state, not a white screen', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getByText } = render(
      <CatchBoundary label="test body">
        <Bomb fuse />
      </CatchBoundary>,
    );
    getByText(/test body crashed: body exploded/);
    spy.mockRestore();
  });

  it('retry REMOUNTS the children clean (key bump), and a healthy child renders', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fuse = true;
    function Flaky(): JSX.Element {
      return <Bomb fuse={fuse} />;
    }
    const { getByText, getByRole } = render(
      <CatchBoundary label="test body">
        <Flaky />
      </CatchBoundary>,
    );
    getByText(/crashed/);
    fuse = false;
    fireEvent.click(getByRole('button'));
    getByText('alive');
    spy.mockRestore();
  });

  it('adds NO wrapper element — children stay direct children (the AlwaysDark lesson)', () => {
    const { container } = render(
      <CatchBoundary label="x">
        <p>child</p>
      </CatchBoundary>,
    );
    expect(container.firstElementChild?.tagName).toBe('P');
  });
});
