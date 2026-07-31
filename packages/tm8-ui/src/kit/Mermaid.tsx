import { useEffect, useRef, useState } from 'react';

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
 */
function themeVariables(host: HTMLElement): Record<string, string> {
  const cs = getComputedStyle(host);
  const vars: Record<string, string> = {};
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
  const put = (key: string, token: string) => {
    const value = cs.getPropertyValue(token).trim();
    if (value !== '') vars[key] = value;
  };

  put('background', '--pn-paper');
  put('primaryColor', '--pn-card');
  put('primaryTextColor', '--pn-ink');
  put('primaryBorderColor', '--pn-line-2');
  put('secondaryColor', '--pn-hover');
  put('tertiaryColor', '--pn-surface');
  put('lineColor', '--pn-ink-3');
  put('textColor', '--pn-ink');
  put('mainBkg', '--pn-card');
  put('nodeBorder', '--pn-line-2');
  put('clusterBkg', '--pn-surface');
  put('clusterBorder', '--pn-line');
  put('titleColor', '--pn-ink');
  put('edgeLabelBackground', '--pn-paper');
  put('actorBorder', '--pn-line-2');
  put('actorBkg', '--pn-card');
  put('noteBkg', '--pn-brand-soft');
  put('noteBorder', '--pn-brand');
  put('fontFamily', '--pn-ui');
  return vars;
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
        mermaid.initialize({
          startOnLoad: false,
          // See §2 of the docblock — this is the trust boundary, not a default.
          securityLevel: 'strict',
          theme: 'base',
          darkMode: dark,
          ...(host ? { themeVariables: themeVariables(host) } : {}),
        });
        renderSeq += 1;
        const { svg } = await mermaid.render(`mmd-${renderSeq}`, source);
        if (!cancelled) setState({ phase: 'ok', svg });
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

  return (
    <div className="md-mermaid" data-testid={testId} ref={hostRef} data-phase={state.phase}>
      {state.phase === 'rendering' ? (
        <span className="md-mermaid__pending">drawing diagram…</span>
      ) : (
        /* Mermaid's own output, sanitised by it under securityLevel:'strict'.
           This is the ONE place the doc pipeline inserts markup it did not
           construct, and it is why the level above is not adjustable here. */
        <div
          className="md-mermaid__svg"
          // eslint-disable-next-line react/no-danger -- see the docblock, §2
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
    </div>
  );
}
