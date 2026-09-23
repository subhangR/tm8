import { useEffect, useRef, useState } from 'react';
import { ZoomableFigure } from './ZoomableFigure';

/**
 * MERMAID DIAGRAMS, rendered for real (user ruling 2026-07-31: "titles, code,
 * mermaid, all this should come").
 *
 * This closes the doc surface's oldest stated gap. `doc-edit/HANDOVER.md` filed
 * it as G2 — "No mermaid/excalidraw renderer" — and the preview drew a hatched
 * panel captioned "not rendered — no diagram renderer ships in this build".
 * That was the honest rendering of not having one. Now there is one.
 *
 * FOUR THINGS THIS FILE IS CAREFUL ABOUT:
 *
 * 1. IT IS LAZY, AND THAT IS NOT AN OPTIMISATION DETAIL. `mermaid` is ~800KB
 *    and drags in d3 and dagre; loading it in the main bundle would tax every
 *    screen in the app — the terminal, the workspace, the rail — to pay for a
 *    fence most documents do not contain. `import('mermaid')` runs on the
 *    first diagram actually rendered and the module is cached after, so a doc
 *    with no diagrams never downloads it.
 *
 * 2. `securityLevel: 'strict'`. A diagram's source is viewer-authored text
 *    that other members of the space will render in their own browsers, which
 *    makes it the same trust boundary as the doc body — and mermaid labels can
 *    carry markup. Strict makes mermaid sanitise its own output and refuse
 *    click-handler directives. This pairs with `kit/Markdown`'s refusal of
 *    `rehype-raw`: the two together are what keep a document from executing.
 *
 * 3. A FAILED DIAGRAM SHOWS ITS SOURCE AND THE ERROR, never an empty box and
 *    never a silent nothing. A diagram that will not parse is a state the
 *    author has to be able to see and fix, and their text is the thing they
 *    need in front of them to fix it. Losing the source to a red box would be
 *    worse than the placeholder this replaces.
 *
 * 4. IT RE-RENDERS ON THEME CHANGE. Mermaid bakes colours into the SVG at
 *    render time rather than reading CSS, so a diagram rendered in light and
 *    then viewed in dark would be black-on-black. The theme is observed and
 *    the diagram re-rendered — which is also why the token colours below are
 *    read from the live computed style rather than hardcoded.
 *
 * 5. THE DRAWN DIAGRAM IS HANDED TO `kit/ZoomableFigure`, WHICH IS NOT A
 *    MERMAID FEATURE. A reader could see a wide flowchart and only pan it
 *    sideways inside the column; expand/zoom/pan is the escape hatch, and it
 *    lives in a shared shell because the chat `explain_graph` card has the
 *    identical squeeze with an SVG this file never touches. Nothing about the
 *    trust boundary moves: that component's controls are SIBLINGS of the
 *    injected subtree and it zooms with a transform on a wrapper OUTSIDE it,
 *    so §2 above still describes the only markup this file does not construct.
 *    Only the drawn phase is wrapped — a diagram that is still rendering, or
 *    one that failed, has nothing to zoom and keeps its plain frame.
 */

/** Module-level, so the ~800KB parse happens once per session, not per block. */
let mermaidModule: Promise<typeof import('mermaid')> | null = null;
function loadMermaid() {
  if (mermaidModule === null) mermaidModule = import('mermaid');
  return mermaidModule;
}

/** Monotonic id: mermaid requires a unique DOM id per render. */
let renderSeq = 0;

function isDark(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[data-theme="dark"]') !== null;
}

/**
 * The diagram's palette, read from the SAME tokens the rest of the page uses,
 * so there is exactly one palette in the package.
 *
 * WHY THIS GREW A COLOUR MODEL (2026-09-18). It used to feed mermaid the
 * SURFACE ramp — `--pn-card` for every node fill, `--pn-line-2` for every
 * border. Those are near-white BY DESIGN, so the result was correctly themed
 * and useless as a diagram: every box in every flowchart came out white with a
 * taupe edge, which a reader fairly called "just black and white". A diagram
 * is the one surface in this package that needs CATEGORICAL colour — "these
 * boxes are different boxes" — and the paper ramp cannot express it, because
 * expressing it is not what a paper ramp is for. Hence the eight-hue wheel in
 * styles/canvas-extra.css.
 *
 * TWO SILENT BUGS FOUND WHILE FIXING IT, both of which had been shipping:
 *
 *   - `noteBkg` and `noteBorder` ARE NOT MERMAID VARIABLES. The real names are
 *     `noteBkgColor` and `noteBorderColor`. The old pair matched nothing, so
 *     every sequence-diagram note had been drawing in mermaid's stock yellow
 *     inside an otherwise themed diagram. Confirmed against the bundle: zero
 *     exact occurrences of either old name, and the note measured as mermaid's
 *     own default rather than as anything this file asked for.
 *
 *   - THE COVERAGE WAS FLOWCHART-AND-SEQUENCE ONLY. A pie, journey, gantt, ER
 *     or state diagram fell through to mermaid's stock theme for most of its
 *     colours, so those diagram types did not match the page at all. The
 *     families below are set explicitly for that reason; each maps to a real
 *     mermaid variable name, verified present in the bundle.
 *
 * WHAT IS DELIBERATELY NOT HERE. No literal colour. The omit-never-default law
 * below is unchanged and is why: a literal here would be a SECOND COPY of the
 * palette, which is what §14's hex ban exists to stop, and a stale copy would
 * diverge silently the first time a token moved.
 */

/** Positions on the wheel. Must match `--pn-x-dia-N` in canvas-extra.css. */
export const DIA_HUES = 8;

/**
 * How far a hue is mixed into the card to make a node FILL. Tuned, not
 * arbitrary: below ~0.15 the fill stops reading as colour once printed, and
 * above ~0.3 the ink label starts losing contrast against it. The fill is
 * DERIVED rather than tokenised so the wheel carries one literal per hue
 * instead of two, and so a fill always tracks the card it sits on — which is
 * what makes the same numbers work in dark, where the card is near-black.
 */
const NODE_FILL_MIX = 0.22;
/** The lighter mix, for fills that sit UNDER text rather than around it. */
const SOFT_FILL_MIX = 0.14;

type Rgb = readonly [number, number, number];

/**
 * Accepts the two forms a resolved custom property actually takes here — `#rgb`
 * / `#rrggbb`, and `rgb()` / `rgba()` — and refuses everything else by
 * returning null rather than guessing. A `color-mix()` token reaches us
 * UNRESOLVED (custom properties compute to a token stream, not a colour), and
 * mermaid's colour maths cannot parse one, so failing to parse here is the
 * correct outcome: the variable is omitted and mermaid keeps its own value.
 */
export function parseColor(value: string): Rgb | null {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex !== null) {
    const digits = hex[1];
    const full =
      digits.length === 3
        ? digits
            .split('')
            .map((c) => `${c}${c}`)
            .join('')
        : digits;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  if (rgb !== null) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function toHex(channels: Rgb): string {
  return `#${channels
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** `weight` is how much of `a` survives. Returns null if either side is unparseable. */
export function mix(a: string, b: string, weight: number): string | null {
  const from = parseColor(a);
  const to = parseColor(b);
  if (from === null || to === null) return null;
  return toHex([0, 1, 2].map((i) => from[i] * weight + to[i] * (1 - weight)) as unknown as Rgb);
}

export interface DiagramPalette {
  /** Mermaid `themeVariables`. */
  vars: Record<string, string>;
  /** Per-position node fills, wheel order. Empty if the wheel did not resolve. */
  fills: string[];
  /** Per-position node strokes, wheel order. Empty if the wheel did not resolve. */
  strokes: string[];
}

export function diagramPalette(host: HTMLElement): DiagramPalette {
  const cs = getComputedStyle(host);
  const vars: Record<string, string> = {};
  const token = (name: string): string => cs.getPropertyValue(name).trim();

  /**
   * A token that does not resolve is OMITTED, never defaulted to a literal.
   *
   * The obvious shape here is a `token(name, literalFallback)` helper, and it
   * is wrong twice: those literals are a SECOND COPY of the palette — what
   * §14's hex ban exists to stop, and the package guard fails the build on
   * them — and a stale copy would silently diverge from `tokens.css` the first
   * time a token moved. Omitting instead lets mermaid fall back to its own
   * theme for that one variable, which is a visible, debuggable result rather
   * than a colour that is subtly not ours.
   */
  const put = (key: string, name: string) => {
    const value = token(name);
    if (value !== '') vars[key] = value;
  };
  /** The same law for a DERIVED value: a failed derivation is omitted, not faked. */
  const set = (key: string, value: string | null) => {
    if (value !== null && value !== '') vars[key] = value;
  };

  const card = token('--pn-card');
  const strokes: string[] = [];
  const fills: string[] = [];
  for (let i = 1; i <= DIA_HUES; i += 1) {
    const hue = token(`--pn-x-dia-${i}`);
    const fill = hue === '' ? null : mix(hue, card, NODE_FILL_MIX);
    // Both halves or neither: a stroke with no fill would paint an outline
    // around mermaid's stock white and read as a half-applied theme.
    if (hue !== '' && fill !== null) {
      strokes.push(hue);
      fills.push(fill);
    }
  }
  const wheel = strokes.length > 0;
  /** Wheel accessors, safe to call only under `wheel`. */
  const hue = (i: number) => strokes[i % strokes.length];
  const fill = (i: number) => fills[i % fills.length];
  const soft = (i: number) => mix(strokes[i % strokes.length], card, SOFT_FILL_MIX);

  /* --- 1 · the shared core, used by every diagram type ---------------------- */
  put('background', '--pn-paper');
  put('primaryTextColor', '--pn-ink');
  put('textColor', '--pn-ink');
  put('titleColor', '--pn-ink');
  put('clusterBkg', '--pn-surface');
  put('clusterBorder', '--pn-line-2');
  put('edgeLabelBackground', '--pn-paper');
  put('fontFamily', '--pn-ui');
  /* The edge/arrow colour was --pn-ink-3, the FAINTEST ink step, which drew
     arrows so pale they read as guides rather than as the flow itself. One
     step darker is still inside the ramp and actually reads as a connector. */
  put('lineColor', '--pn-ink-2');

  if (wheel) {
    /* Node defaults come off the wheel's first position rather than the card,
       so a diagram type with no per-node rotation (see nodePaletteCss) is
       still coloured instead of white. */
    set('primaryColor', fill(0));
    set('mainBkg', fill(0));
    set('primaryBorderColor', hue(0));
    set('nodeBorder', hue(0));
    set('secondaryColor', fill(1));
    set('tertiaryColor', fill(2));
  } else {
    /* The wheel is the only NEW dependency this file has. If canvas-extra.css
       is missing or renamed, fall back to the old surface-ramp behaviour —
       monochrome, but themed and readable — rather than to mermaid's stock
       lavender, which belongs to no palette here. */
    put('primaryColor', '--pn-card');
    put('mainBkg', '--pn-card');
    put('primaryBorderColor', '--pn-line-2');
    put('nodeBorder', '--pn-line-2');
    put('secondaryColor', '--pn-hover');
    put('tertiaryColor', '--pn-surface');
  }

  /* --- 2 · sequence -------------------------------------------------------- */
  put('actorTextColor', '--pn-ink');
  put('actorLineColor', '--pn-ink-3');
  put('signalColor', '--pn-ink-2');
  put('signalTextColor', '--pn-ink');
  put('labelTextColor', '--pn-ink');
  put('loopTextColor', '--pn-ink');
  put('noteTextColor', '--pn-ink');
  put('sequenceNumberColor', '--pn-card');
  if (wheel) {
    set('actorBkg', fill(0));
    set('actorBorder', hue(0));
    set('labelBoxBkgColor', fill(3));
    set('labelBoxBorderColor', hue(3));
    set('activationBkgColor', fill(1));
    set('activationBorderColor', hue(1));
    /* THE FIXED NAMES. `noteBkg`/`noteBorder` matched nothing; these are real. */
    set('noteBkgColor', soft(3));
    set('noteBorderColor', hue(3));
  } else {
    put('actorBkg', '--pn-card');
    put('actorBorder', '--pn-line-2');
  }

  /* --- 3 · state ----------------------------------------------------------- */
  put('labelColor', '--pn-ink');
  put('altBackground', '--pn-surface');
  put('compositeBackground', '--pn-surface');
  put('compositeTitleBackground', '--pn-hover');
  put('compositeBorder', '--pn-line-2');
  put('transitionColor', '--pn-ink-2');
  put('transitionLabelColor', '--pn-ink');
  /* Start/end terminators stay INK, never a hue: they are punctuation, not a
     box, and colouring them makes a state diagram read as having two extra
     states. The rotation in nodePaletteCss skips them for the same reason. */
  put('specialStateColor', '--pn-ink-2');
  put('innerEndBackground', '--pn-ink-2');

  /* --- 4 · entity-relationship & class ------------------------------------- */
  put('attributeBackgroundColorOdd', '--pn-surface');
  put('attributeBackgroundColorEven', '--pn-card');
  put('classText', '--pn-ink');

  /* --- 5 · the counted families: pie, journey/timeline, git ----------------
     These take a colour PER SERIES, and mermaid names them by index. Left
     unset they fall to mermaid's stock rainbow, which is the single loudest
     way a diagram stops looking like this product. Cycling the wheel keeps
     them in-palette and keeps series N the same hue as node position N. */
  if (wheel) {
    for (let i = 0; i < 12; i += 1) {
      set(`pie${i + 1}`, hue(i));
      set(`cScale${i}`, hue(i));
      set(`cScaleInv${i}`, fill(i));
      put(`cScaleLabel${i}`, '--pn-card');
      if (i < 8) {
        set(`git${i}`, hue(i));
        put(`gitBranchLabel${i}`, '--pn-card');
        /* A journey's SECTION bands. Measured unset: the bands themed
           correctly off cScale while the actor dots beside them stayed on
           mermaid's stock darkseagreen, which is the giveaway that a family
           was missed rather than that the diagram type is unsupported. */
        set(`fillType${i}`, soft(i));
      }
      /* A journey's ACTOR dots, which mermaid names separately from every
         other series and caps at six. */
      if (i < 6) set(`actor${i}`, hue(i));
    }
    put('pieTitleTextColor', '--pn-ink');
    put('pieLegendTextColor', '--pn-ink');
    put('pieSectionTextColor', '--pn-card');
    put('pieStrokeColor', '--pn-card');
    put('pieOuterStrokeColor', '--pn-line-2');
    /* Mermaid's stock pie is 70% opaque over the page. Ours are already soft
       enough; leaving it translucent just muddies them against the paper. */
    vars.pieOpacity = '1';
  }

  /* --- 6 · gantt ----------------------------------------------------------- */
  put('gridColor', '--pn-line');
  put('taskTextColor', '--pn-ink');
  put('taskTextDarkColor', '--pn-ink');
  put('taskTextOutsideColor', '--pn-ink');
  put('taskTextLightColor', '--pn-card');
  put('doneTaskBkgColor', '--pn-hover');
  put('doneTaskBorderColor', '--pn-line-2');
  put('altSectionBkgColor', '--pn-card');
  if (wheel) {
    set('sectionBkgColor', soft(0));
    set('sectionBkgColor2', soft(2));
    set('taskBkgColor', fill(1));
    set('taskBorderColor', hue(1));
    set('activeTaskBkgColor', fill(3));
    set('activeTaskBorderColor', hue(3));
    set('critBkgColor', fill(4));
    set('critBorderColor', hue(4));
    set('todayLineColor', hue(5));
  }

  return { vars, fills, strokes };
}

/**
 * The per-node rotation, as CSS appended to the diagram's OWN `<style>`.
 *
 * WHY CSS AND NOT A THEME VARIABLE. Mermaid has no "colour each node
 * differently" setting; `mainBkg` is one colour for every node in the diagram.
 * The only per-node hook it offers is `classDef`, which is the AUTHOR's. So a
 * default rotation has to come from outside mermaid's theme system.
 *
 * WHY INSIDE THE SVG rather than in a stylesheet. Two reasons, and the second
 * is the one that bites:
 *   - Specificity. Mermaid writes `#<id> .node rect{fill:…}` into the diagram,
 *     an id-carrying rule that an external class selector cannot outrank
 *     without `!important` anyway.
 *   - THE PRINT CLONE. `doc-edit/printDoc` clones the body into a sibling root
 *     OUTSIDE `.cv2-root`, where this package's tokens do not cascade — the
 *     trap that silently strips fonts and class-scoped rules from printed
 *     output. A rule living inside the SVG travels WITH the SVG into that
 *     clone, already resolved to literals, so the printed diagram is coloured
 *     for the same reason the on-screen one is. An external rule referencing
 *     `var(--pn-x-dia-N)` would resolve on screen and silently fail in the PDF.
 *
 * AUTHOR INTENT STILL WINS. Mermaid compiles `classDef` to an INLINE
 * `style="fill:… !important"` on the shape, and an inline `!important`
 * outranks a stylesheet `!important` in the cascade. So a node the author
 * coloured keeps the author's colour and only the UNSTYLED ones rotate —
 * verified rather than assumed.
 */
export function nodePaletteCss(id: string, palette: DiagramPalette, svg: string): string {
  if (palette.strokes.length === 0) return '';

  /* Which diagram types rotate, decided from the type mermaid itself declares
     on the root element. Sequence, pie, gantt and journey are NOT here: they
     have no `g.node` boxes, and their colour comes from the counted families
     above. */
  const kind = /aria-roledescription="([^"]+)"/.exec(svg)?.[1] ?? '';
  let node: string;
  if (kind.startsWith('flowchart')) node = 'g.node';
  else if (kind === 'er' || kind === 'class' || kind === 'requirement') node = 'g.node';
  /* A state diagram's start/end dots are also `g.node`, classed `default`,
     while real states carry `statediagram-state`. Rotating the dots would draw
     two pale boxes where the diagram means "begins" and "ends". */
  else if (kind === 'stateDiagram') node = 'g.node.statediagram-state';
  else return '';

  /* Descendant, not child: most shapes are direct children of the node group
     but some (the stadium/rounded forms) sit one level down inside a
     container, and a child combinator silently leaves exactly those white. */
  const shapes = ['rect', 'polygon', 'path', 'circle', 'ellipse'];
  const n = palette.strokes.length;
  return palette.strokes
    .map((stroke, i) => {
      const selector = shapes
        .map((shape) => `#${id} g.nodes > ${node}:nth-of-type(${n}n+${i + 1}) ${shape}`)
        .join(',');
      return `${selector}{fill:${palette.fills[i]}!important;stroke:${stroke}!important;}`;
    })
    .join('');
}

/** Appends the rotation to the diagram's own stylesheet, or returns it unchanged. */
export function withNodePalette(svg: string, css: string): string {
  if (css === '') return svg;
  const at = svg.lastIndexOf('</style>');
  return at < 0 ? svg : `${svg.slice(0, at)}${css}${svg.slice(at)}`;
}

export interface MermaidProps {
  /** The diagram source, verbatim from the fence. */
  source: string;
  testId?: string;
}

type Phase =
  | { phase: 'rendering' }
  | { phase: 'ok'; svg: string }
  | { phase: 'failed'; message: string };

export function Mermaid({ source, testId = 'mermaid' }: MermaidProps) {
  const [state, setState] = useState<Phase>({ phase: 'rendering' });
  const hostRef = useRef<HTMLDivElement>(null);
  const [dark, setDark] = useState(isDark);

  /**
   * The theme is an ATTRIBUTE on an ancestor, not a React value, so the only
   * way to hear about it is to watch the DOM. Without this a diagram keeps the
   * palette it was born with and goes unreadable on the next theme toggle.
   */
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined;
    const observer = new MutationObserver(() => setDark(isDark()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
      subtree: true,
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'rendering' });

    void (async () => {
      try {
        const { default: mermaid } = await loadMermaid();
        if (cancelled) return;
        const host = hostRef.current;
        const palette = host === null ? null : diagramPalette(host);
        mermaid.initialize({
          startOnLoad: false,
          // See §2 of the docblock — this is the trust boundary, not a default.
          securityLevel: 'strict',
          theme: 'base',
          darkMode: dark,
          /* On a parse failure mermaid APPENDS its own "Syntax error in text"
             graphic to <body>. That element is outside this component, so it
             survives unmount, stacks up one per failed render, and -- the way
             it was found -- gets swept into the print clone, where it prints
             as an orphan error banner ABOVE the document title. We already
             render our own failure state with the source in a code fence, so
             mermaid's copy is duplicate content in the wrong place. */
          suppressErrorRendering: true,
          ...(palette === null ? {} : { themeVariables: palette.vars }),
        });
        renderSeq += 1;
        /* The id is needed AFTER the render too: the rotation rules are scoped
           to it, because mermaid scopes its own rules the same way and two
           diagrams share one document. */
        const id = `mmd-${renderSeq}`;
        const { svg } = await mermaid.render(id, source);
        if (cancelled) return;
        setState({
          phase: 'ok',
          svg: palette === null ? svg : withNodePalette(svg, nodePaletteCss(id, palette, svg)),
        });
      } catch (error: unknown) {
        if (cancelled) return;
        setState({
          phase: 'failed',
          message: String((error as { message?: string })?.message ?? error),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, dark]);

  if (state.phase === 'failed') {
    /* The source survives the failure — see §3. */
    return (
      <div className="md-mermaid md-mermaid--failed" data-testid={`${testId}-failed`}>
        <p className="md-mermaid__error">
          <strong>This diagram could not be drawn.</strong> {state.message}
        </p>
        <pre className="md-mermaid__source">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  if (state.phase === 'rendering') {
    return (
      <div className="md-mermaid" data-testid={testId} ref={hostRef} data-phase="rendering">
        <span className="md-mermaid__pending">drawing diagram…</span>
      </div>
    );
  }

  /**
   * `hostRef` stays on the ROOT in every phase, which is why the figure takes
   * it rather than the wrapper below. The render effect reads the palette off
   * `hostRef.current` after an await, and on a theme change that await resolves
   * while the previous phase's DOM is still mounted — a ref that only existed
   * in one phase would read `null` there and silently drop the whole palette
   * back to mermaid's defaults.
   */
  return (
    <ZoomableFigure
      ref={hostRef}
      className="md-mermaid"
      label="Diagram"
      testId={testId}
      dataAttrs={{ 'data-phase': state.phase }}
    >
      {/* Mermaid's own output, sanitised by it under securityLevel:'strict'.
          This is the ONE place the doc pipeline inserts markup it did not
          construct, and it is why the level above is not adjustable here. */}
      <div
        className="md-mermaid__svg"
        // eslint-disable-next-line react/no-danger -- see the docblock, §2
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    </ZoomableFigure>
  );
}
