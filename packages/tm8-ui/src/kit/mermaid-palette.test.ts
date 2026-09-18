// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DIA_HUES,
  diagramPalette,
  mix,
  nodePaletteCss,
  parseColor,
  withNodePalette,
  type DiagramPalette,
} from './Mermaid';

/**
 * THE DIAGRAM PALETTE, tested against the CSS THAT ACTUALLY SHIPS.
 *
 * The bug these tests exist to stop had one symptom — "colors of the boxes not
 * just black and white" — and one cause: every categorical slot mermaid offers
 * was being fed a near-white SURFACE token, so a twenty-node architecture
 * diagram drew twenty identical white boxes outlined in the same taupe. That is
 * not a rendering failure, which is why nothing errored and no test caught it:
 * the diagram was drawn correctly in a palette with no categories in it.
 *
 * So these do NOT assert against a fixture palette. They parse the real
 * `styles/tokens.css` and `styles/canvas-extra.css` into jsdom and read the
 * wheel back through `getComputedStyle`, which is the same path the component
 * uses in a browser. A fixture would have passed happily while the shipped
 * hues were missing, renamed or collapsed to one colour — the exact regression
 * worth guarding.
 *
 * NOT asserted here, deliberately: that an author's `classDef` still beats the
 * rotation. That property is a cascade rule — inline `!important` outranks
 * stylesheet `!important` — and jsdom does not implement enough of the cascade
 * to distinguish the two. Asserting it here would produce a test that passes
 * whether or not the property holds, which is worse than no test. It was
 * verified in a real browser instead, on a `classDef hot fill:#f96` node.
 */

const CV2 = 'cv2-root';

function loadStyles(...files: string[]): void {
  for (const file of files) {
    const style = document.createElement('style');
    style.textContent = readFileSync(file, 'utf8');
    document.head.append(style);
  }
}

/**
 * A host carrying `.cv2-root`, which is where tm8-ui's tokens are defined.
 *
 * In the browser the host is a DESCENDANT of `.cv2-root` and the tokens reach
 * it by inheritance. jsdom does not implement custom-property inheritance —
 * `getComputedStyle` on a child returns "" for a property its ancestor
 * defines — so mounting the host as a child here would test jsdom's gap rather
 * than the palette, and every wheel assertion would fail against CSS that is
 * demonstrably correct. Putting the class on the host itself reads the same
 * declarations through the same API, one hop earlier.
 */
function mountHost(): HTMLElement {
  const host = document.createElement('div');
  host.className = CV2;
  document.body.append(host);
  return host;
}

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('parseColor', () => {
  it('reads the two forms a resolved custom property actually takes', () => {
    expect(parseColor('#4E7FB5')).toEqual([78, 127, 181]);
    expect(parseColor('  #4e7fb5  ')).toEqual([78, 127, 181]);
    expect(parseColor('rgb(78, 127, 181)')).toEqual([78, 127, 181]);
    expect(parseColor('rgba(78, 127, 181, 0.5)')).toEqual([78, 127, 181]);
    expect(parseColor('rgb(78 127 181)')).toEqual([78, 127, 181]);
  });

  it('expands #rgb shorthand rather than misreading it', () => {
    expect(parseColor('#f96')).toEqual([255, 153, 102]);
    expect(parseColor('#FFF')).toEqual([255, 255, 255]);
  });

  it('refuses an unresolved color-mix() instead of guessing', () => {
    // A custom property computes to a TOKEN STREAM, so a color-mix() token
    // reaches us verbatim. Mermaid's colour maths cannot parse one either, so
    // returning null — which omits the variable — is the correct outcome.
    expect(parseColor('color-mix(in srgb, #4E7FB5 22%, #FFFFFF)')).toBeNull();
  });

  it('refuses everything it cannot read exactly', () => {
    for (const bad of ['', '   ', 'rebeccapurple', '#12345', 'var(--pn-card)', 'hsl(210 40% 50%)']) {
      expect(parseColor(bad)).toBeNull();
    }
  });
});

describe('mix', () => {
  it('weights toward the first colour', () => {
    expect(mix('#000000', '#ffffff', 1)).toBe('#000000');
    expect(mix('#000000', '#ffffff', 0)).toBe('#ffffff');
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('always returns a full six-digit hex, clamped', () => {
    const out = mix('#4E7FB5', '#FFFFFF', 0.22);
    expect(out).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('propagates a failed parse as null rather than a wrong colour', () => {
    expect(mix('color-mix(in srgb, red, blue)', '#ffffff', 0.5)).toBeNull();
    expect(mix('#ffffff', '', 0.5)).toBeNull();
  });
});

describe('diagramPalette, against the shipped stylesheets', () => {
  it('resolves the whole wheel from canvas-extra.css', () => {
    loadStyles('src/styles/tokens.css', 'src/styles/canvas-extra.css');
    const palette = diagramPalette(mountHost());
    expect(palette.strokes).toHaveLength(DIA_HUES);
    expect(palette.fills).toHaveLength(DIA_HUES);
  });

  it('gives every position a DISTINCT colour — the monochrome regression guard', () => {
    loadStyles('src/styles/tokens.css', 'src/styles/canvas-extra.css');
    const palette = diagramPalette(mountHost());
    expect(new Set(palette.strokes).size).toBe(DIA_HUES);
    expect(new Set(palette.fills).size).toBe(DIA_HUES);
  });

  it('derives fills that are neither the card nor the raw hue', () => {
    loadStyles('src/styles/tokens.css', 'src/styles/canvas-extra.css');
    const host = mountHost();
    const card = getComputedStyle(host).getPropertyValue('--pn-card').trim().toLowerCase();
    const palette = diagramPalette(host);
    for (const [i, fill] of palette.fills.entries()) {
      expect(fill).toMatch(/^#[0-9a-f]{6}$/);
      // A fill equal to the card is the old bug exactly: a white box.
      expect(fill.toLowerCase()).not.toBe(card);
      expect(fill.toLowerCase()).not.toBe(palette.strokes[i].toLowerCase());
    }
  });

  it('emits the note keys mermaid actually reads', () => {
    // `noteBkg`/`noteBorder` are NOT theme variables — they had zero exact
    // occurrences in the mermaid bundle and only matched as prefixes of the
    // real names, so sequence notes shipped mermaid's stock yellow inside an
    // otherwise themed diagram for as long as the renderer has existed.
    loadStyles('src/styles/tokens.css', 'src/styles/canvas-extra.css');
    const { vars } = diagramPalette(mountHost());
    expect(vars).toHaveProperty('noteBkgColor');
    expect(vars).toHaveProperty('noteBorderColor');
    expect(vars).not.toHaveProperty('noteBkg');
    expect(vars).not.toHaveProperty('noteBorder');
  });

  it('draws edges in --pn-ink-2, not the faintest ink step', () => {
    loadStyles('src/styles/tokens.css', 'src/styles/canvas-extra.css');
    const host = mountHost();
    const cs = getComputedStyle(host);
    const { vars } = diagramPalette(host);
    expect(vars.lineColor).toBe(cs.getPropertyValue('--pn-ink-2').trim());
    expect(vars.lineColor).not.toBe(cs.getPropertyValue('--pn-ink-3').trim());
  });

  it('fills the counted families mermaid requires whole', () => {
    // pie/cScale/git are indexed families: mermaid reads pie1..pie12 by name
    // and a gap is a stock colour in the middle of an otherwise themed chart.
    loadStyles('src/styles/tokens.css', 'src/styles/canvas-extra.css');
    const { vars } = diagramPalette(mountHost());
    for (let i = 1; i <= 12; i += 1) expect(vars).toHaveProperty(`pie${i}`);
    for (let i = 0; i <= 11; i += 1) expect(vars).toHaveProperty(`cScale${i}`);
    for (let i = 0; i <= 7; i += 1) expect(vars).toHaveProperty(`git${i}`);
    expect(vars.pieOpacity).toBe('1');
  });

  it('omits a token it cannot resolve instead of defaulting to a literal', () => {
    // No stylesheets at all: every token is empty. The palette must come back
    // EMPTY rather than carrying a second, stale copy of the design system.
    const { vars, fills, strokes } = diagramPalette(mountHost());
    expect(fills).toEqual([]);
    expect(strokes).toEqual([]);
    for (const [key, value] of Object.entries(vars)) {
      // `pieOpacity` is the one genuine constant, not a colour.
      if (key === 'pieOpacity') continue;
      expect(value, `${key} should not have been invented`).not.toMatch(/^#/);
    }
  });

  it('still themes the diagram when only the wheel is missing', () => {
    // canvas-extra.css absent — the graceful path. Core variables must still
    // resolve so the diagram is tm8-coloured, just without per-node rotation.
    loadStyles('src/styles/tokens.css');
    const { vars, fills } = diagramPalette(mountHost());
    expect(fills).toEqual([]);
    expect(vars.background).toBeTruthy();
    expect(vars.textColor).toBeTruthy();
    expect(vars.lineColor).toBeTruthy();
  });
});

describe('nodePaletteCss', () => {
  const palette: DiagramPalette = {
    vars: {},
    fills: ['#aaaaaa', '#bbbbbb'],
    strokes: ['#111111', '#222222'],
  };
  const svgOf = (kind: string) =>
    `<svg aria-roledescription="${kind}"><style>.x{}</style><g class="nodes"></g></svg>`;

  it('rotates flowchart nodes, one rule per wheel position', () => {
    const css = nodePaletteCss('mmd-1', palette, svgOf('flowchart-v2'));
    expect(css.split('}').filter(Boolean)).toHaveLength(2);
    expect(css).toContain('nth-of-type(2n+1)');
    expect(css).toContain('nth-of-type(2n+2)');
    expect(css).toContain('fill:#aaaaaa!important');
    expect(css).toContain('stroke:#111111!important');
  });

  it('uses a DESCENDANT combinator so stadium shapes are not left white', () => {
    // The shape is usually a direct child of the node group, but the
    // rounded/stadium forms sit one level down inside a container. A child
    // combinator silently leaves exactly those nodes unpainted.
    const css = nodePaletteCss('mmd-1', palette, svgOf('flowchart-v2'));
    expect(css).toContain('g.node:nth-of-type(2n+1) rect');
    expect(css).not.toContain('g.node:nth-of-type(2n+1)>rect');
  });

  it('paints every shape mermaid draws a node with', () => {
    const css = nodePaletteCss('mmd-1', palette, svgOf('flowchart-v2'));
    for (const shape of ['rect', 'polygon', 'path', 'circle', 'ellipse']) {
      expect(css).toContain(`:nth-of-type(2n+1) ${shape}`);
    }
  });

  it('scopes a state diagram to real states, sparing the start and end dots', () => {
    const css = nodePaletteCss('mmd-1', palette, svgOf('stateDiagram'));
    expect(css).toContain('g.node.statediagram-state');
    // A bare `g.node` would catch the two dots and draw pale boxes where the
    // diagram means "begins" and "ends".
    expect(css).not.toMatch(/g\.node:nth-of-type/);
  });

  it('rotates er and class diagrams, which do have node boxes', () => {
    expect(nodePaletteCss('mmd-1', palette, svgOf('er'))).toContain('g.node');
    expect(nodePaletteCss('mmd-1', palette, svgOf('class'))).toContain('g.node');
  });

  it('leaves the box-less diagram types alone', () => {
    // These colour through the counted families instead; a g.node rule would
    // match nothing at best and the wrong element at worst.
    for (const kind of ['sequence', 'pie', 'gantt', 'journey', 'gitGraph', '']) {
      expect(nodePaletteCss('mmd-1', palette, svgOf(kind)), kind).toBe('');
    }
  });

  it('emits nothing when the wheel did not resolve', () => {
    const empty: DiagramPalette = { vars: {}, fills: [], strokes: [] };
    expect(nodePaletteCss('mmd-1', empty, svgOf('flowchart-v2'))).toBe('');
  });

  it('scopes every rule to the rendered id so diagrams cannot bleed', () => {
    const css = nodePaletteCss('mmd-7', palette, svgOf('flowchart-v2'));
    for (const selector of css.split('{')[0].split(',')) {
      expect(selector.trim().startsWith('#mmd-7')).toBe(true);
    }
  });
});

describe('withNodePalette', () => {
  it('inserts INSIDE the svg, before the last style close', () => {
    // This is what makes the colour survive the print clone: the rules travel
    // inside the SVG itself rather than living in a stylesheet the clone
    // (which mounts outside `.cv2-root`) never sees.
    const svg = '<svg><style>a{}</style><g/><style>b{}</style></svg>';
    const out = withNodePalette(svg, 'RULES');
    expect(out).toBe('<svg><style>a{}</style><g/><style>b{}RULES</style></svg>');
    expect(out.indexOf('RULES')).toBeLessThan(out.indexOf('</svg>'));
  });

  it('returns the svg untouched when there is nothing to add', () => {
    const svg = '<svg><style>a{}</style></svg>';
    expect(withNodePalette(svg, '')).toBe(svg);
  });

  it('returns the svg untouched when it carries no stylesheet', () => {
    const svg = '<svg><g/></svg>';
    expect(withNodePalette(svg, 'RULES')).toBe(svg);
  });
});
