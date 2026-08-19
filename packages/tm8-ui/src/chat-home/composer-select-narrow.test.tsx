// @vitest-environment jsdom
/**
 * THE HOOK THE NARROW FOOT HANGS ON, AND WHY IT NEEDS A TEST AT ALL.
 *
 * Below a 360px composer the foot drops the teammate trigger's NAME and keeps
 * its avatar, because the face already answers "which teammate" and the word
 * beside it was the only thing in the row that could go without costing an
 * answer. That rule is CSS (`.tch-pick--faced .tch-pick__value`), and jsdom
 * loads no stylesheets — so nothing here can assert that the name disappears
 * at 359px and stays at 361px. A browser did that; the numbers are in the
 * chat-home.css docblock.
 *
 * What jsdom CAN hold is the seam the rule selects on, which is the half that
 * silently rots: `tch-pick--faced` is emitted by this component and consumed
 * by a stylesheet that never imports it. Rename or drop the class and the CSS
 * simply stops matching — no type error, no failing render, just a composer
 * that quietly goes back to overlapping its Send button on a narrow pane. That
 * is the defect this file is a witness for, and the reason the assertions are
 * about the class and the tooltip rather than about layout.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { ComposerSelect } from './ComposerSelect';

const ACTOR_ID = '019f0000-0000-7000-8000-0000000000a1' as EntityId;

const TEAMMATES = [
  { id: ACTOR_ID, label: 'Opus 5 Teammate', actor: { id: ACTOR_ID, avatar: null } },
];
const MODELS = [{ id: 'claude-opus-5', label: 'Claude Opus 5', hint: 'Anthropic' }];

describe('ComposerSelect in a narrow foot', () => {
  it('marks a trigger that draws a face, so the CSS can trade its word for the avatar', () => {
    const { getByTestId } = render(
      <ComposerSelect
        label="Chat teammate"
        testId="tch-teammate"
        options={TEAMMATES}
        value={ACTOR_ID}
        onChange={vi.fn()}
        emptyNote="No agent teammate is available in this space."
      />,
    );

    const pick = getByTestId('tch-teammate').closest('.tch-pick');
    expect(pick?.classList.contains('tch-pick--faced')).toBe(true);
  });

  it('does NOT mark a trigger that is only a word — hiding that value would leave a caret with no subject', () => {
    const { getByTestId } = render(
      <ComposerSelect
        label="Chat model"
        testId="tch-model"
        options={MODELS}
        value="claude-opus-5"
        onChange={vi.fn()}
        emptyNote="No model is available from the launch catalog."
      />,
    );

    const pick = getByTestId('tch-model').closest('.tch-pick');
    expect(pick?.classList.contains('tch-pick--faced')).toBe(false);
  });

  it('keeps the full selection reachable as a tooltip, since the visible value is ellipsized or hidden', () => {
    const { getByTestId } = render(
      <ComposerSelect
        label="Chat model"
        testId="tch-model"
        options={MODELS}
        value="claude-opus-5"
        onChange={vi.fn()}
        emptyNote="No model is available from the launch catalog."
      />,
    );

    const trigger = getByTestId('tch-model');
    expect(trigger.getAttribute('title')).toBe('Claude Opus 5');
    /* AND THE ACCESSIBLE NAME IS STILL THE LABEL ALONE. The tooltip is for the
       eye; folding the selection into the name would rename the control on
       every change and break every query that ever found it — the rule this
       component's own docblock sets. Asserting it here is what stops the
       tooltip from drifting into `aria-label` the next time someone wants the
       value announced. */
    expect(trigger.getAttribute('aria-label')).toBe('Chat model');
  });
});
