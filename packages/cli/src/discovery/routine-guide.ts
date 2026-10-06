import { WORKER_ROUTINE_STEPS, WORKER_ROUTINE_LEAD } from '@tm8/prompt';
import type { GuideSection } from './form-guide.js';

/**
 * `tm8 help routine`: the worker routine (task P0g), rendered from the same
 * steps the worker system prompt carries, so the two can never disagree.
 */
export function routineGuide(): GuideSection[] {
  return [
    { title: 'Why', lines: [WORKER_ROUTINE_LEAD] },
    ...WORKER_ROUTINE_STEPS.map((s, i) => ({ title: `${i + 1}. ${s.name}`, lines: [s.rule] })),
  ];
}
