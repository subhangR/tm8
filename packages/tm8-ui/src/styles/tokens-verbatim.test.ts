import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Anti-drift guard: src/styles/tokens.css is a VERBATIM copy of the design
 * package's tokens.css (charter: "ground truth, use verbatim"). Any edit —
 * even whitespace — must happen in the design package first and be re-copied,
 * or this test fails.
 */

const DESIGN_TOKENS =
  '/Users/subhang/Desktop/Projects/tm8/T0-1 workspace structure review (1)/uploads/tm8-ui-design/05-DESIGN-SYSTEM/tokens.css';

const LOCAL_TOKENS = fileURLToPath(new URL('./tokens.css', import.meta.url));

describe('tokens.css verbatim transplant', () => {
  it('is byte-identical to the design package source', () => {
    const design = readFileSync(DESIGN_TOKENS);
    const local = readFileSync(LOCAL_TOKENS);
    expect(local.equals(design), 'src/styles/tokens.css has drifted from the design tokens.css — re-copy, never hand-edit').toBe(true);
  });
});
