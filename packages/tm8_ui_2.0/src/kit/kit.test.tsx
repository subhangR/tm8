// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import {
  Avatar,
  BootLoader,
  Btn,
  Chip,
  Eyebrow,
  IconBtn,
  Kbd,
  LabelCountBadge,
  Pill,
} from './index';

describe('kit primitives', () => {
  it('Pill carries tone class and the word (never color alone)', () => {
    const { container, getByText } = render(<Pill tone="run" dot="pulse">live</Pill>);
    expect(container.querySelector('.kit-pill--run')).not.toBeNull();
    expect(container.querySelector('.kit-pill__dot--pulse')).not.toBeNull();
    getByText('live');
  });

  it('Pill outline variant renders the filter form', () => {
    const { container } = render(<Pill outline>filter ▾</Pill>);
    expect(container.querySelector('.kit-pill--outline')).not.toBeNull();
  });

  it('LabelCountBadge keeps the noun separate and tooltips the expendable count', () => {
    const { container, getByText } = render(
      <LabelCountBadge label="Sessions" count="2,281 new" />,
    );
    const badge = container.querySelector('.kit-label-count');
    expect(getByText('Sessions').className).toBe('kit-label-count__label');
    expect(container.querySelector('.kit-label-count__quantity')?.textContent).toBe('· 2,281 new');
    expect(badge?.getAttribute('title')).toBe('Sessions: 2,281 new');
  });

  it('LabelCountBadge gives width to the noun before the count', () => {
    const root = block(kitCss, '.kit-label-count {', 'kit.css');
    const label = block(kitCss, '.kit-label-count__label', 'kit.css');
    const quantity = block(kitCss, '.kit-label-count__quantity', 'kit.css');
    expect(root).toMatch(/min-width:\s*0/);
    expect(label).toMatch(/flex:\s*0 0 auto/);
    expect(label).not.toMatch(/overflow|text-overflow/);
    expect(quantity).toMatch(/min-width:\s*0/);
    expect(quantity).toMatch(/flex:\s*0 1 auto/);
    expect(quantity).toMatch(/overflow:\s*hidden/);
    expect(quantity).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('LabelCountBadge accepts precise count tooltip copy', () => {
    const { container } = render(
      <LabelCountBadge label="Pull requests" count={121} countTooltip="121 pull requests" />,
    );
    expect(container.querySelector('.kit-label-count')?.getAttribute('title')).toBe(
      '121 pull requests',
    );
  });

  it('Eyebrow renders mono micro-label with faint variant', () => {
    const { container } = render(<Eyebrow faint>Runs · 1 live</Eyebrow>);
    expect(container.querySelector('.kit-eyebrow--faint')).not.toBeNull();
  });

  it('Chip renders glyph as aria-hidden decoration', () => {
    const { container, getByRole } = render(<Chip glyph="⑂">PR #212</Chip>);
    getByRole('button', { name: 'PR #212' });
    expect(container.querySelector('.kit-chip__glyph')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('IconBtn is always labeled for screen readers', () => {
    const { getByRole } = render(<IconBtn label="Pin panel">⌗</IconBtn>);
    const btn = getByRole('button', { name: 'Pin panel' });
    expect(btn.getAttribute('aria-label')).toBe('Pin panel');
  });

  it('Kbd renders a <kbd> element in boxed and bare forms', () => {
    const { container } = render(<Kbd bare>esc</Kbd>);
    const el = container.querySelector('kbd');
    expect(el?.className).toContain('kit-kbd--bare');
  });

  it('Avatar shape follows provenance: humans round, agents rounded-square', () => {
    const human = render(<Avatar actorId="actor-ada" provenance="human" label="Ada" size={22} />);
    const agent = render(<Avatar actorId="actor-forge" provenance="agent" label="forge" size={22} />);
    expect(human.container.querySelector('.kit-avatar--human')).not.toBeNull();
    expect(agent.container.querySelector('.kit-avatar--agent')).not.toBeNull();
    // shape is never the only carrier — the display name is the accessible name
    human.getByRole('img', { name: 'Ada' });
    agent.getByRole('img', { name: 'forge' });
  });

  it('Avatar defaults initials to the first character, uppercased', () => {
    const { container } = render(<Avatar actorId="actor-forge" provenance="agent" label="forge" size={15} />);
    expect(container.textContent).toBe('F');
    expect(container.querySelector('.kit-avatar--mono')).not.toBeNull();
  });

  it('BootLoader announces itself as a live status, never a silent wait', () => {
    const { getByRole } = render(<BootLoader />);
    const status = getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toContain('loading workspace');
  });

  it('BootLoader mark is decorative — the label is the accessible name', () => {
    const { container } = render(<BootLoader />);
    // The ring carries no meaning a reader needs; the label does.
    expect(container.querySelector('.kit-boot__mark')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.kit-boot__label')?.textContent).toBe('loading workspace');
  });

  it('BootLoader states the stage when the caller knows it', () => {
    const { container } = render(<BootLoader label="opening space" detail="reading the graph" />);
    expect(container.querySelector('.kit-boot__label')?.textContent).toBe('opening space');
    expect(container.querySelector('.kit-boot__detail')?.textContent).toBe('reading the graph');
  });

  it('BootLoader omits the detail line entirely when there is nothing to say', () => {
    const { container } = render(<BootLoader />);
    expect(container.querySelector('.kit-boot__detail')).toBeNull();
  });
});

describe('honest disabled — disabledReason on Chip and IconBtn', () => {
  it('Chip with disabledReason: aria-disabled, reason as tooltip, click inert', () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <Chip onClick={onClick} title="open the PR" disabledReason="This PR has already merged">
        PR #212
      </Chip>,
    );
    const btn = getByRole('button', { name: 'PR #212' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    /* The reason REPLACES the caller title — a dead control's tooltip must
       say why it is dead, not what it would have done. */
    expect(btn.getAttribute('title')).toBe('This PR has already merged');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Chip without disabledReason stays live: no aria-disabled, click fires', () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <Chip onClick={onClick} title="open the PR">
        PR #212
      </Chip>,
    );
    const btn = getByRole('button', { name: 'PR #212' });
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    expect(btn.getAttribute('title')).toBe('open the PR');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('IconBtn with disabledReason: aria-disabled, reason as tooltip, click inert — label stays the verb', () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <IconBtn label="Pin panel" onClick={onClick} disabledReason="Nothing is open to pin">
        ⌗
      </IconBtn>,
    );
    /* aria-label keeps naming the control; only the title carries the refusal. */
    const btn = getByRole('button', { name: 'Pin panel' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('title')).toBe('Nothing is open to pin');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('IconBtn without disabledReason stays live and titled by its label', () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <IconBtn label="Pin panel" onClick={onClick}>
        ⌗
      </IconBtn>,
    );
    const btn = getByRole('button', { name: 'Pin panel' });
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    expect(btn.getAttribute('title')).toBe('Pin panel');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

/**
 * The one focus grammar — read off the stylesheets, because nothing else can
 * read them: jsdom implements no layout and no cascade over external CSS, so
 * a rendered-DOM assertion cannot see whether keyboard focus paints a ring.
 * Same pattern as mobile/msheet-size.test.ts: strip comments first (the rules
 * are annotated with the very strings being asserted), then slice ONE rule's
 * declarations so a match cannot come from elsewhere in the sheet.
 */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const here = dirname(fileURLToPath(import.meta.url));
const kitCss = strip(readFileSync(join(here, 'kit.css'), 'utf8'));
const diffCss = strip(readFileSync(join(here, 'diff.css'), 'utf8'));
const mdCss = strip(readFileSync(join(here, 'markdown.css'), 'utf8'));

function block(css: string, selector: string, sheet: string): string {
  const at = css.indexOf(selector);
  expect(at, `${selector} is not in ${sheet}`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

/* The grammar itself: 2px solid through the dedicated --pn-focus token with
   the brass fallback — the exact wave-1 ring (panels.css, auth.css). */
const RING = /outline:\s*2px solid var\(--pn-focus,\s*var\(--pn-brand-2\)\)/;

describe('kit focus rings — every interactive atom, one grammar', () => {
  it.each([
    ['.kit-chip:focus-visible', kitCss, 'kit.css'],
    ['.kit-iconbtn:focus-visible', kitCss, 'kit.css'],
    ['button.kit-actorref__via:focus-visible', kitCss, 'kit.css'],
    ['button.kit-actorref__session:focus-visible', kitCss, 'kit.css'],
    ['.kit-diff__file-link:focus-visible', diffCss, 'diff.css'],
    ['.kit-diff__more:focus-visible', diffCss, 'diff.css'],
    ['.md-link:focus-visible', mdCss, 'markdown.css'],
  ] as const)('%s carries the --pn-focus ring', (selector, css, sheet) => {
    expect(block(css, selector, sheet)).toMatch(RING);
  });

  it('IconBtn ring no longer flows through --pn-brand (the drift the audit flagged)', () => {
    expect(block(kitCss, '.kit-iconbtn:focus-visible', 'kit.css')).not.toMatch(
      /var\(--pn-brand\)/,
    );
  });

  it('ActorRef via/session buttons gain calm border feedback (they had zero state CSS)', () => {
    expect(block(kitCss, 'button.kit-actorref__via:hover', 'kit.css')).toMatch(
      /border-color:\s*var\(--pn-line-2\)/,
    );
  });

  it('disabled Chip and IconBtn are painted dead: dimmed, not-allowed, hover tint suppressed', () => {
    const chip = block(kitCss, ".kit-chip[aria-disabled='true']", 'kit.css');
    expect(chip).toMatch(/color:\s*var\(--pn-ink-4\)/);
    expect(chip).toMatch(/cursor:\s*not-allowed/);
    expect(block(kitCss, ".kit-chip[aria-disabled='true']:hover", 'kit.css')).toMatch(
      /background:\s*var\(--pn-card\)/,
    );
    const icon = block(kitCss, ".kit-iconbtn[aria-disabled='true']", 'kit.css');
    expect(icon).toMatch(/cursor:\s*not-allowed/);
    expect(block(kitCss, ".kit-iconbtn[aria-disabled='true']:hover", 'kit.css')).toMatch(
      /background:\s*transparent/,
    );
  });
});

describe('calm primitive surfaces', () => {
  it('status pills keep semantic ink on a neutral bordered card', () => {
    const pill = block(kitCss, '.kit-pill {', 'kit.css');
    expect(pill).toMatch(/background:\s*var\(--pn-card\)/);
    expect(pill).toMatch(/border:\s*1px solid var\(--pn-line\)/);
    expect(block(kitCss, '.kit-pill--run', 'kit.css')).not.toMatch(/background/);
  });

  it('avatars keep stable identity at a hairline instead of a tinted fill', () => {
    const avatar = block(kitCss, '.kit-avatar.kit-avatar {', 'kit.css');
    expect(avatar).toMatch(/background:\s*var\(--pn-card\)/);
    expect(avatar).toMatch(/border:\s*1px solid var\(--kit-avatar-tone\)/);
    expect(avatar).not.toMatch(/color-mix/);
  });

  it('chip and icon-button hover states strengthen edges without tint fields', () => {
    const chip = block(kitCss, '.kit-chip:hover', 'kit.css');
    expect(chip).toMatch(/background:\s*var\(--pn-card\)/);
    expect(chip).toMatch(/border-color:\s*var\(--pn-line-2\)/);
    const icon = block(kitCss, '.kit-iconbtn:hover', 'kit.css');
    expect(icon).toMatch(/background:\s*transparent/);
    expect(icon).toMatch(/border-color:\s*var\(--pn-line\)/);
  });
});

describe('Btn — the Kinetic button grammar component', () => {
  it('renders a real <button> carrying base + variant class', () => {
    const { getByRole } = render(<Btn variant="brand">Run</Btn>);
    const btn = getByRole('button', { name: 'Run' });
    expect(btn.className).toBe('k-btn k-btn--brand');
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('defaults to the secondary variant — the safe neutral', () => {
    const { getByRole } = render(<Btn>Cancel</Btn>);
    expect(getByRole('button', { name: 'Cancel' }).className).toBe('k-btn k-btn--secondary');
  });

  it('sm adds the 28px modifier class', () => {
    const { getByRole } = render(<Btn variant="ghost" sm>More</Btn>);
    expect(getByRole('button', { name: 'More' }).className).toBe(
      'k-btn k-btn--ghost k-btn--sm',
    );
  });

  it('with disabledReason: aria-disabled, reason as tooltip, click inert', () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <Btn variant="primary" onClick={onClick} title="Create the task" disabledReason="A run is already in flight">
        Create
      </Btn>,
    );
    const btn = getByRole('button', { name: 'Create' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    /* The reason REPLACES the caller title — a dead control's tooltip must
       say why it is dead, not what it would have done. */
    expect(btn.getAttribute('title')).toBe('A run is already in flight');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('without disabledReason stays live: no aria-disabled, caller title, click fires', () => {
    const onClick = vi.fn();
    const { getByRole } = render(
      <Btn variant="primary" onClick={onClick} title="Create the task">
        Create
      </Btn>,
    );
    const btn = getByRole('button', { name: 'Create' });
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    expect(btn.getAttribute('title')).toBe('Create the task');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

/**
 * The Kinetic experience grammar — CSS-as-text contract for the `k-` classes
 * (same jsdom-cannot-see-the-cascade rationale as the focus-ring suite above).
 */
describe('kinetic grammar — button/input/label/icon CSS contract', () => {
  it.each([
    ['.k-btn:focus-visible'],
    ['.k-input:focus-visible'],
    ['.k-select:focus-visible'],
  ] as const)('%s carries the --pn-focus ring', (selector) => {
    expect(block(kitCss, selector, 'kit.css')).toMatch(RING);
  });

  it('.k-btn base: 32px border-box row, r-sm radius, sm face at weight 600', () => {
    const base = block(kitCss, '.k-btn', 'kit.css');
    expect(base).toMatch(/box-sizing:\s*border-box/);
    expect(base).toMatch(/height:\s*32px/);
    expect(base).toMatch(/padding:\s*0 14px/);
    expect(base).toMatch(/border-radius:\s*var\(--pn-r-sm\)/);
    expect(base).toMatch(/font-size:\s*var\(--pn-fs-sm\)/);
    expect(base).toMatch(/font-weight:\s*600/);
    expect(base).toMatch(/gap:\s*6px/);
    expect(base).toMatch(/cursor:\s*pointer/);
    expect(base).toMatch(/transition/);
  });

  it('.k-btn disabled is painted dead: ink-4, dimmed, not-allowed', () => {
    const dead = block(kitCss, ".k-btn[aria-disabled='true']", 'kit.css');
    expect(dead).toMatch(/color:\s*var\(--pn-ink-4\)/);
    expect(dead).toMatch(/opacity:\s*0\.45/);
    expect(dead).toMatch(/cursor:\s*not-allowed/);
  });

  it('variant surfaces: purposeful fills, calm bordered neutrals, no mixed hover tints', () => {
    expect(block(kitCss, '.k-btn--primary', 'kit.css')).toMatch(/background:\s*var\(--pn-ink\)/);
    expect(block(kitCss, '.k-btn--primary:hover', 'kit.css')).not.toMatch(/color-mix/);
    expect(block(kitCss, '.k-btn--brand', 'kit.css')).toMatch(/background:\s*var\(--pn-brand\)/);
    expect(block(kitCss, '.k-btn--brand:hover', 'kit.css')).toMatch(
      /background:\s*var\(--pn-brand-2\)/,
    );
    const secondary = block(kitCss, '.k-btn--secondary', 'kit.css');
    expect(secondary).toMatch(/background:\s*var\(--pn-card\)/);
    expect(secondary).toMatch(/border-color:\s*var\(--pn-line-2\)/);
    const ghost = block(kitCss, '.k-btn--ghost', 'kit.css');
    expect(ghost).toMatch(/background:\s*transparent/);
    expect(ghost).toMatch(/color:\s*var\(--pn-ink-2\)/);
    expect(block(kitCss, '.k-btn--ghost:hover', 'kit.css')).toMatch(
      /border-color:\s*var\(--pn-line\)/,
    );
  });

  it('.k-btn--sm is the 28px compact form on the label face', () => {
    const sm = block(kitCss, '.k-btn--sm', 'kit.css');
    expect(sm).toMatch(/height:\s*28px/);
    expect(sm).toMatch(/font-size:\s*var\(--pn-fs-label\)/);
  });

  it('.k-input: 32px border-box card field with line-2 edge; --sm is 28px', () => {
    const input = block(kitCss, '.k-input', 'kit.css');
    expect(input).toMatch(/box-sizing:\s*border-box/);
    expect(input).toMatch(/height:\s*32px/);
    expect(input).toMatch(/padding:\s*0 10px/);
    expect(input).toMatch(/background:\s*var\(--pn-card\)/);
    expect(input).toMatch(/border:\s*1px solid var\(--pn-line-2\)/);
    expect(input).toMatch(/border-radius:\s*var\(--pn-r-sm\)/);
    expect(block(kitCss, '.k-input--sm', 'kit.css')).toMatch(/height:\s*28px/);
  });

  it('.k-select drops the native arrow; .k-selectwrap::after draws the ▾ inert', () => {
    const select = block(kitCss, '.k-select', 'kit.css');
    expect(select).toMatch(/appearance:\s*none/);
    expect(select).toMatch(/background:\s*var\(--pn-card\)/);
    expect(select).not.toMatch(/background-image/);
    const arrow = block(kitCss, '.k-selectwrap::after', 'kit.css');
    expect(arrow).toMatch(/content:\s*'▾'/);
    expect(arrow).toMatch(/pointer-events:\s*none/);
    expect(arrow).toMatch(/position:\s*absolute/);
  });

  it('.k-label: caps face, 11px/700, +0.06em uppercase, ink-2', () => {
    const label = block(kitCss, '.k-label', 'kit.css');
    expect(label).toMatch(/font-family:\s*var\(--pn-caps\)/);
    expect(label).toMatch(/font-size:\s*var\(--pn-fs-micro\)/);
    expect(label).toMatch(/font-weight:\s*700/);
    expect(label).toMatch(/letter-spacing:\s*var\(--pn-track-label\)/);
    expect(label).toMatch(/text-transform:\s*uppercase/);
    expect(label).toMatch(/color:\s*var\(--pn-ink-2\)/);
  });

  it('icon rhythm: .k-icon-16 and .k-icon-18 size and never squash', () => {
    const i16 = block(kitCss, '.k-icon-16', 'kit.css');
    expect(i16).toMatch(/width:\s*16px/);
    expect(i16).toMatch(/height:\s*16px/);
    expect(i16).toMatch(/flex:\s*none/);
    const i18 = block(kitCss, '.k-icon-18', 'kit.css');
    expect(i18).toMatch(/width:\s*18px/);
    expect(i18).toMatch(/height:\s*18px/);
    expect(i18).toMatch(/flex:\s*none/);
  });
});

/**
 * The wave-3 MOTION + COLOR RICHNESS layer — CSS-as-text, same rationale as
 * the suites above. The load-bearing assertions are the NEGATIVE ones: every
 * motion utility dies under prefers-reduced-motion, and motion stays opt-in
 * (no blanket transition can reach a status pill).
 */
describe('kinetic motion — every utility has a reduced-motion kill', () => {
  /* The layer's one kill switch is the LAST reduced-motion block in kit.css
     (the section is appended; earlier blocks belong to other atoms). Sliced
     with lastIndexOf so a match cannot come from those earlier blocks. */
  const rmAt = kitCss.lastIndexOf('@media (prefers-reduced-motion: reduce)');
  const reduced = kitCss.slice(rmAt);

  it('the kill-switch media block exists after the motion utilities', () => {
    expect(rmAt).toBeGreaterThan(kitCss.indexOf('.k-shimmer'));
  });

  it.each([
    ['.k-enter'],
    ['.k-enter-pop'],
    ['.k-lift'],
    ['.k-press'],
    ['.k-shimmer'],
    ['.k-underline-slide'],
  ] as const)('%s appears in the reduced-motion kill block', (cls) => {
    expect(reduced).toContain(cls);
  });

  it('the kill block collapses to instant state: no animation, transform, or transition', () => {
    expect(reduced).toMatch(/animation:\s*none/);
    expect(reduced).toMatch(/transform:\s*none/);
    expect(reduced).toMatch(/transition:\s*none/);
    /* Entrances must LAND, not vanish: reduced users get the end state. */
    expect(reduced).toMatch(/opacity:\s*1/);
  });

  it('.k-enter: fade+4px rise on ease-out, base duration, fill both', () => {
    expect(block(kitCss, '@keyframes kEnter {', 'kit.css')).toMatch(/translateY\(4px\)/);
    const enter = block(kitCss, '.k-enter {', 'kit.css');
    expect(enter).toMatch(/animation:\s*kEnter var\(--pn-dur-base\) var\(--pn-ease-out\)/);
    expect(enter).toMatch(/animation-fill-mode:\s*both/);
  });

  it('.k-enter-pop: scale .98→1 on the spring ease', () => {
    expect(block(kitCss, '@keyframes kEnterPop {', 'kit.css')).toMatch(/scale\(0\.98\)/);
    const pop = block(kitCss, '.k-enter-pop {', 'kit.css');
    expect(pop).toMatch(/animation:\s*kEnterPop var\(--pn-dur-base\) var\(--pn-ease-spring\)/);
    expect(pop).toMatch(/animation-fill-mode:\s*both/);
  });

  it('.k-lift: a 1px edge strengthens on hover without elevation shadow', () => {
    const lift = block(kitCss, '.k-lift {', 'kit.css');
    expect(lift).toMatch(/border:\s*1px solid var\(--pn-line\)/);
    expect(lift).toMatch(/box-shadow:\s*none/);
    const hover = block(kitCss, '.k-lift:hover', 'kit.css');
    expect(hover).toMatch(/border-color:\s*var\(--pn-line-2\)/);
    expect(hover).toMatch(/box-shadow:\s*none/);
    expect(hover).not.toMatch(/transform/);
  });

  it('.k-press and .k-btn both press on :active — and a dead .k-btn does not', () => {
    expect(block(kitCss, '.k-press:active', 'kit.css')).toMatch(/scale\(0\.985\)/);
    expect(block(kitCss, '.k-btn:active', 'kit.css')).toMatch(/scale\(0\.985\)/);
    expect(block(kitCss, ".k-btn[aria-disabled='true']:active", 'kit.css')).toMatch(
      /transform:\s*none/,
    );
  });

  it('.k-shimmer: color-mix sweep over --pn-hover, 1.6s linear infinite', () => {
    const shimmer = block(kitCss, '.k-shimmer', 'kit.css');
    expect(shimmer).toMatch(/color-mix\(in srgb, var\(--pn-ink\) 6%, var\(--pn-hover\)\)/);
    expect(shimmer).toMatch(/animation:\s*kShimmer 1\.6s linear infinite/);
  });

  it('.k-underline-slide: brand ::after scales in from the left on hover/current', () => {
    const after = block(kitCss, '.k-underline-slide::after', 'kit.css');
    expect(after).toMatch(/background:\s*var\(--pn-brand\)/);
    expect(after).toMatch(/transform:\s*scaleX\(0\)/);
    expect(after).toMatch(/transform-origin:\s*left/);
    expect(block(kitCss, '.k-underline-slide:hover::after', 'kit.css')).toMatch(
      /transform:\s*scaleX\(1\)/,
    );
  });

  it('motion stays OPT-IN: no blanket transition can reach a status pill', () => {
    /* The no-motion-status law. Nothing in kit.css may put a transition or
       animation on the pill atoms — a status word changing tone must snap.
       (The dot pulse is a LIVENESS signal on the dot span, not a state
       transition, and it predates this layer; it is asserted killed below.) */
    expect(kitCss).not.toMatch(/\.kit-pill[^_{]*\{[^}]*transition/);
    expect(block(kitCss, '.kit-pill {', 'kit.css')).not.toMatch(/animation|transition/);
  });
});

describe('calm surfaces — neutral cards and 1px grouping edges', () => {
  it('.k-hero: card surface and hairline edge, no tint gradient', () => {
    const hero = block(kitCss, '.k-hero', 'kit.css');
    expect(hero).toMatch(/background:\s*var\(--pn-card\)/);
    expect(hero).toMatch(/border:\s*1px solid var\(--pn-line\)/);
    expect(hero).not.toMatch(/gradient|color-mix|box-shadow/);
  });

  it('.k-accent-top: one stronger top hairline, no ribbon pseudo-element', () => {
    const edge = block(kitCss, '.k-accent-top {', 'kit.css');
    expect(edge).toMatch(/border-top:\s*1px solid var\(--pn-line-2\)/);
    expect(kitCss).not.toContain('.k-accent-top::before');
  });

  it.each([
    ['.k-tint-brand'],
    ['.k-tint-run'],
    ['.k-tint-wait'],
    ['.k-tint-block'],
    ['.k-tint-info'],
  ] as const)('%s resolves to the shared neutral card rule', (cls) => {
    const calm = block(kitCss, cls, 'kit.css');
    expect(calm).toMatch(/background:\s*var\(--pn-card\)/);
    expect(calm).toMatch(/border:\s*1px solid var\(--pn-line\)/);
    expect(calm).not.toMatch(/color-mix|gradient|box-shadow/);
  });
});
