import { CANONICAL_EDGES, NON_CANONICAL_EDGES } from '@tm8/contract';
import type { GuideSection } from './form-guide.js';

/**
 * `tm8 help edge-type`: one edge per meaning (Design Rules §2.3). Rendered from
 * the contract's CANONICAL_EDGES, never restated; each type's one-line meaning
 * is in the registry and prints with `tm8 edge type list`.
 */
export function edgeTypeGuide(): GuideSection[] {
  const line = (e: (typeof CANONICAL_EDGES)[number]): string =>
    `${e.meaning}: ${e.type} (${e.direction}) — ${e.how}`;
  return [
    { title: 'You write these, when the meaning applies', lines: CANONICAL_EDGES.filter((e) => e.writtenBy === 'agent').map(line) },
    { title: 'The server records these; never write them by hand', lines: CANONICAL_EDGES.filter((e) => e.writtenBy === 'server').map(line) },
    { title: 'Not an edge, or not canonical', lines: [
      'A sub-item of the same kind (subtask, sub-doc, child story, sub-session) is --parent, never an edge.',
      ...Object.entries(NON_CANONICAL_EDGES).map(([type, why]) => `${type}: ${why}`),
      'tm8 edge type list prints every registered type with its endpoints and one-line meaning.',
    ] },
  ];
}
