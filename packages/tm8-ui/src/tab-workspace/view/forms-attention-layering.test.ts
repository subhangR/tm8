import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Overlay layering in Work (task 01a112b9). jsdom computes no stacking, so the
 * contract is pinned on the stylesheets themselves:
 *  - the forms popover is fixed and stacks over the tab's title bar and the
 *    attention dock;
 *  - the action strip rises over the content while one of its popovers is open;
 *  - a session's "Waiting on you" banner starts below the overlaying title bar,
 *    and the bar does not slide away over it.
 */
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const content = read('./content.css');
const attention = read('../../attention/attention-surfaces.css');

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  const at = css.split('}').find((chunk) => chunk.split('{')[0]!.trim().replace(/\s+/g, ' ') === selector);
  expect(at, `no rule for ${selector}`).toBeTruthy();
  const out: Record<string, string> = {};
  for (const decl of at!.split('{')[1]!.split(';')) {
    const [k, ...v] = decl.split(':');
    if (k && v.length) out[k.trim()] = v.join(':').trim();
  }
  return out;
}
const z = (decls: Record<string, string>) => Number(decls['z-index']);

describe('forms and attention overlays in Work', () => {
  const titlebar = z(rule(content, '.tws-titlebar'));
  const dock = z(rule(attention, '.cv2-root .att-block-dock'));

  it('the forms popover is fixed and above the title bar and the attention dock', () => {
    const pop = rule(content, '.cv2-root .pf-chip__pop');
    expect(pop.position).toBe('fixed');
    expect(z(pop)).toBeGreaterThan(titlebar);
    expect(z(pop)).toBeGreaterThan(dock);
    expect(pop['overflow-y']).toBe('auto');
    expect(pop['white-space']).toBe('normal');
  });

  it('the strip rises over the content while a popover of its own is open', () => {
    expect(z(rule(content, '.tws-astrip'))).toBeLessThan(titlebar);
    const raised = rule(content, '.tws-astrip:has(.tws-astrip-popover, .tws-astrip-menu, .tws-astrip-outline[data-open])');
    expect(z(raised)).toBeGreaterThan(titlebar);
    expect(z(raised)).toBeGreaterThan(dock);
  });

  it('a waiting banner sits below the overlaying title bar, which stays while it is up', () => {
    const height = rule(content, '.tws-titlebar').height;
    expect(rule(content, ".tws-entity-host:has(> .tws-titlebar) .pn-panel[data-embedded-flow='fill'] .att-banner")['margin-top']).toBe(height);
    expect(rule(content, ".tws-entity-host:has(.pn-panel[data-embedded-flow='fill'] .att-banner) > .tws-titlebar[data-hidden]").transform).toBe('none');
  });
});
