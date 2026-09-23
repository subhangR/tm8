import type { JevCost } from '@tm8/contract';

import { formatGroupCost, formatRunCost } from './format';

/**
 * What asking cost, straight from the answer's `cost` (one group) or `run`
 * (the whole Ask Jev run). Never computed here: the server prices the calls.
 */
export function JevCostLine(props: { cost: JevCost; testId?: string } | { run: JevCost; testId?: string }) {
  const text = 'run' in props ? formatRunCost(props.run) : formatGroupCost(props.cost);
  return (
    <span
      className={'run' in props ? 'jev-cost jev-cost--run' : 'jev-cost'}
      data-testid={props.testId ?? ('run' in props ? 'jev-run-cost' : undefined)}
    >
      {text}
    </span>
  );
}
