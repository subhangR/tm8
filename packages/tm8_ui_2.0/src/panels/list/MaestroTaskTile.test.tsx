// @vitest-environment jsdom
import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MaestroTaskTile } from './MaestroTaskTile';

function mountParent() {
  const onToggleChildren = vi.fn();
  const onChangeState = vi.fn();
  const onSelect = vi.fn();

  render(
    <div className="cv2-root">
      <MaestroTaskTile
        rootRef={createRef<HTMLDivElement>()}
        id="parent-task"
        family="blue"
        title="Parent task"
        depth={0}
        selected={false}
        attention={false}
        completed={false}
        archived={false}
        childCount={2}
        childrenExpanded={false}
        onToggleChildren={onToggleChildren}
        onSelect={onSelect}
        status={{ label: 'working', tone: 'run', hollow: false, streaming: false }}
        statusControl={
          <button
            type="button"
            aria-label="Change state for Parent task, currently working"
            onClick={(event) => {
              event.stopPropagation();
              onChangeState();
            }}
          />
        }
        assignees={[]}
        creator={null}
        actions={
          <>
            {Array.from({ length: 5 }, (_, index) => (
              <button key={index} type="button" aria-label={`Action ${index + 1}`} />
            ))}
          </>
        }
        detailsExpanded={false}
        flowOpen={false}
        onToggleDetails={vi.fn()}
      />
    </div>,
  );

  return { onToggleChildren, onChangeState, onSelect };
}

describe('MaestroTaskTile parent-row controls', () => {
  it('keeps Expand children and Change state distinct, with isolated callbacks', () => {
    const callbacks = mountParent();
    const disclosure = screen.getByRole('button', { name: 'Expand Parent task, 2 children' });
    const status = screen.getByRole('button', {
      name: 'Change state for Parent task, currently working',
    });

    expect(disclosure).not.toBe(status);
    expect(
      disclosure.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(disclosure.parentElement).toBe(status.closest('.pn-tt__status')?.parentElement);

    fireEvent.click(disclosure);
    expect(callbacks.onToggleChildren).toHaveBeenCalledTimes(1);
    expect(callbacks.onChangeState).not.toHaveBeenCalled();
    expect(callbacks.onSelect).not.toHaveBeenCalled();

    fireEvent.click(status);
    expect(callbacks.onChangeState).toHaveBeenCalledTimes(1);
    expect(callbacks.onToggleChildren).toHaveBeenCalledTimes(1);
    expect(callbacks.onSelect).not.toHaveBeenCalled();
  });
});
