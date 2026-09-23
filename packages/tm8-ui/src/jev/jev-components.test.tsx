// @vitest-environment jsdom
/**
 * The Ask Jev components on their own: the checklist's 32-memory refusal is
 * SAID at the row, the cost strings are the design's (§6), and the model hint
 * never applies while refused.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

import { MEMORY_IDS_MAX } from '../domain/memory';
import { JevChecklist } from './JevChecklist';
import { JevModelHint } from './JevModelHint';
import { formatGroupCost, formatRunCost } from './format';
import { answer, cost, item, MODEL, okGroup, pendingPort } from './test-support';
import { MEMORY_LIMIT_REASON, useJevSuggestions } from './useJevSuggestions';

function MemoryHarness({ port }: { port: ReturnType<typeof pendingPort> }) {
  const jev = useJevSuggestions({ port, spaceId: 'sp-1', subjectId: 'task-1', teammateId: 'tm-1' });
  return (
    <>
      <button type="button" onClick={() => jev.ask()}>ask</button>
      <JevChecklist
        kind="memory"
        state={jev.groups.memories}
        ticked={jev.ticked.memory}
        refusal={jev.tickRefusal?.kind === 'memory' ? jev.tickRefusal : null}
        onToggle={(id) => jev.toggle('memory', id)}
        onRetry={jev.retry}
      />
    </>
  );
}

describe('JevChecklist', () => {
  it('refuses a 33rd memory with the reason on screen, and the box stays unticked', async () => {
    const port = pendingPort();
    const view = render(<MemoryHarness port={port} />);
    fireEvent.click(view.getByText('ask'));
    const items = Array.from({ length: 40 }, (_, i) =>
      item(`mem-${String(i).padStart(2, '0')}`, 'memory', 2.9 - i / 100, i < MEMORY_IDS_MAX));
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input, {
      memories: okGroup({ items, considered: 40, total: 40 }),
    })));
    expect(view.getByTestId('jev-memory-count').textContent).toBe(`✦ ${String(MEMORY_IDS_MAX)} of 40 ticked · exact set`);

    const box = view.getByTestId('jev-row-mem-35').querySelector('input')!;
    fireEvent.click(box);
    expect(view.getByTestId('jev-memory-refusal').textContent).toBe(MEMORY_LIMIT_REASON);
    expect(box.checked).toBe(false);
    expect(box.getAttribute('aria-describedby')).toBe('jev-memory-refusal');
    expect(view.getByTestId('jev-memory-count').textContent).toBe(`✦ ${String(MEMORY_IDS_MAX)} of 40 ticked · exact set`);
  });

  it('says "N of M considered" only when Jev saw fewer than there are', () => {
    const state = okGroup({ items: [item('sk-a', 'skill', 2, true)], considered: 240, total: 812 });
    const view = render(<JevChecklist kind="skill" state={state} ticked={['sk-a']} refusal={null} onToggle={() => {}} onRetry={() => {}} />);
    expect(view.getByTestId('jev-skill-considered').textContent).toBe('240 of 812 considered');
    view.rerender(<JevChecklist kind="skill" state={okGroup({ ...state.value, considered: 1, total: 1 })} ticked={[]} refusal={null} onToggle={() => {}} onRetry={() => {}} />);
    expect(view.queryByTestId('jev-skill-considered')).toBeNull();
  });
});

describe('cost strings (design §6)', () => {
  it('per group and per run', () => {
    expect(formatGroupCost(cost(1, 0.00004, 400))).toBe('$0.00004 · 0.4 s');
    expect(formatRunCost(cost(7, 0.00021, 1100))).toBe('✦ 7 calls · 1.1 s · $0.00021');
    expect(formatRunCost(cost(1, 0.00004, 400))).toBe('✦ 1 call · 0.4 s · $0.00004');
  });
});

describe('JevModelHint', () => {
  it('a refused Apply does nothing when clicked', () => {
    const onApply = vi.fn();
    const view = render(
      <JevModelHint state={okGroup(MODEL)} label="Claude Sonnet 5" refusal="nope" applied={false} onApply={onApply} onRetry={() => {}} />,
    );
    fireEvent.click(view.getByTestId('jev-model-apply'));
    expect(onApply).not.toHaveBeenCalled();
    expect(view.getByTestId('jev-model-apply').getAttribute('title')).toBe('nope');
  });

  it('shows Jev’s reasons in a disclosure', () => {
    const view = render(
      <JevModelHint state={okGroup(MODEL)} label="Claude Sonnet 5" refusal={null} applied={false} onApply={() => {}} onRetry={() => {}} />,
    );
    expect(view.getByText('why')).toBeTruthy();
    expect(view.getByText('Moderate depth.')).toBeTruthy();
  });
});
