// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Avatar, BootLoader, Chip, Eyebrow, IconBtn, Kbd, Pill } from './index';

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

  it('ActorRef via/session buttons gained hover feedback (they had zero state CSS)', () => {
    expect(block(kitCss, 'button.kit-actorref__via:hover', 'kit.css')).toMatch(
      /background:\s*var\(--pn-hover\)/,
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
