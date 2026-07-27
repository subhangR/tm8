// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Avatar, Chip, Eyebrow, IconBtn, Kbd, Pill } from './index';

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
    const human = render(<Avatar provenance="human" label="Ada" size={22} />);
    const agent = render(<Avatar provenance="agent" label="forge" size={22} />);
    expect(human.container.querySelector('.kit-avatar--human')).not.toBeNull();
    expect(agent.container.querySelector('.kit-avatar--agent')).not.toBeNull();
    // shape is never the only carrier — the display name is the accessible name
    human.getByRole('img', { name: 'Ada' });
    agent.getByRole('img', { name: 'forge' });
  });

  it('Avatar defaults initials to the first character, uppercased', () => {
    const { container } = render(<Avatar provenance="agent" label="forge" size={15} />);
    expect(container.textContent).toBe('F');
    expect(container.querySelector('.kit-avatar--mono')).not.toBeNull();
  });
});
