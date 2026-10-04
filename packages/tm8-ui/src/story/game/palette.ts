/**
 * The scene's colours, read from the design tokens AT RUNTIME. three.js wants
 * concrete colour strings and §14 bans hex in source, so a probe element asks
 * the browser what each `--pn-*` token resolves to (dark theme included) and
 * the scene is handed the answers. Outside a styled document (tests, a host
 * without the tokens) the fallbacks are plain CSS colour functions.
 */
export interface Palette {
  ink: string;
  ink3: string;
  surface: string;
  card: string;
  line: string;
  line2: string;
  brand: string;
  run: string;
  info: string;
  block: string;
  wait: string;
  merged: string;
}

const TOKENS: Readonly<Record<keyof Palette, [token: string, fallback: string]>> = {
  ink: ['--pn-ink', 'hsl(35 13% 12%)'],
  ink3: ['--pn-ink-3', 'hsl(44 8% 52%)'],
  surface: ['--pn-surface', 'hsl(48 38% 97%)'],
  card: ['--pn-card', 'hsl(0 0% 100%)'],
  line: ['--pn-line', 'hsl(43 23% 88%)'],
  line2: ['--pn-line-2', 'hsl(43 19% 81%)'],
  brand: ['--pn-brand', 'hsl(28 61% 43%)'],
  run: ['--pn-run', 'hsl(141 39% 40%)'],
  info: ['--pn-info', 'hsl(207 39% 41%)'],
  block: ['--pn-block', 'hsl(8 51% 49%)'],
  wait: ['--pn-wait', 'hsl(40 64% 45%)'],
  merged: ['--pn-pr-merged', 'hsl(264 28% 51%)'],
};

export function readPalette(host: HTMLElement): Palette {
  const probe = host.ownerDocument.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  // Theme/reduced-motion rules can otherwise interpolate every read from inherited ink.
  probe.style.setProperty('transition', 'none', 'important');
  probe.style.setProperty('animation', 'none', 'important');
  host.appendChild(probe);
  const out = {} as Record<keyof Palette, string>;
  try {
    for (const key of Object.keys(TOKENS) as Array<keyof Palette>) {
      const [token, fallback] = TOKENS[key];
      probe.style.color = `var(${token})`;
      const got = host.ownerDocument.defaultView?.getComputedStyle(probe).color ?? '';
      out[key] = got && got !== 'rgba(0, 0, 0, 0)' ? got : fallback;
    }
  } finally {
    probe.remove();
  }
  return out;
}

/** Does this document have a GL context to draw into? Asked without touching a canvas when the API is absent. */
export function hasWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof (window as unknown as { WebGL2RenderingContext?: unknown }).WebGL2RenderingContext === 'undefined' &&
      typeof (window as unknown as { WebGLRenderingContext?: unknown }).WebGLRenderingContext === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    const context = c.getContext('webgl2');
    const supported = !!context;
    context?.getExtension('WEBGL_lose_context')?.loseContext();
    return supported;
  } catch {
    return false;
  }
}
