// @vitest-environment jsdom
/**
 * THE COMPOSER FIELD'S HEIGHT (audit A2, composer-states mockup §2) — the pure
 * rule, the phone stylesheet that makes it `22n + 10`, and `ComposerCard`
 * measuring on the draft rather than on every render.
 */
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ComposerCard } from './ComposerCard';
import { capOf, fieldFit } from './fieldFit';

const CSS = readFileSync(`${process.cwd()}/src/rich-input/rich-input.css`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The phone field: 16px type on a 22px line, 5px block padding, capped at five lines. */
const field = (lines: number): number => 22 * lines + 10;
const CAP = field(5);

describe('fieldFit', () => {
  it('is exactly the text height, 22n + 10, from one line up to the five-line cap', () => {
    expect([1, 2, 3, 4, 5].map((n) => fieldFit(field(n), CAP).height)).toEqual([32, 54, 76, 98, 120]);
    for (let n = 1; n <= 5; n += 1) expect(fieldFit(field(n), CAP).capped).toBe(false);
  });

  it('holds the cap past five lines, and only then may the field scroll', () => {
    expect(fieldFit(field(6), CAP)).toEqual({ height: 120, capped: true });
    expect(fieldFit(field(40), CAP)).toEqual({ height: 120, capped: true });
  });

  it('treats a missing cap as no cap', () => {
    expect(capOf('none')).toBe(Number.POSITIVE_INFINITY);
    expect(capOf('')).toBe(Number.POSITIVE_INFINITY);
    expect(capOf('120px')).toBe(120);
    expect(fieldFit(500, capOf('none'))).toEqual({ height: 500, capped: false });
  });
});

describe('the phone field stylesheet', () => {
  const rule = (selector: string): string => {
    const at = CSS.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return CSS.slice(CSS.indexOf('{', at) + 1, CSS.indexOf('}', at));
  };

  it('sets an integer 22px line with 5px block padding and a 5-line cap', () => {
    const body = rule(".cv2-root[data-shell='mobile'] .ri-card textarea");
    expect(body).toMatch(/font-size:\s*16px/);
    expect(body).toMatch(/line-height:\s*22px/);
    expect(body).toMatch(/padding:\s*5px 6px/);
    expect(body).toMatch(/max-height:\s*calc\(5 \* 22px \+ 10px\)/);
  });

  it('never draws a scrollbar, and scrolls only once capped', () => {
    const body = rule(".cv2-root[data-shell='mobile'] .ri-card textarea");
    expect(body).toMatch(/overflow-y:\s*hidden/);
    expect(body).toMatch(/scrollbar-width:\s*none/);
    expect(CSS).toMatch(/\.ri-card textarea::-webkit-scrollbar \{\s*display:\s*none/);
    expect(rule(".cv2-root[data-shell='mobile'] .ri-card textarea[data-capped]")).toMatch(/overflow-y:\s*auto/);
  });

  it('leaves the desktop field on its own rule', () => {
    expect(CSS).not.toMatch(/\.cv2-root \.mobile-frame \.ri-card textarea/);
    expect(rule('.ri-card textarea')).toMatch(/font:\s*13px\/1\.45/);
  });
});

describe('ComposerCard', () => {
  afterEach(cleanup);

  /** jsdom lays nothing out, so `scrollHeight` is stubbed per field: lines × 22 + 10. */
  function Host({ text, tick }: { text: string; tick: number }) {
    return (
      <ComposerCard
        draft={text}
        field={<textarea data-tick={tick} value={text} readOnly style={{ maxHeight: `${CAP}px` }} />}
        foot={<button type="button">Send</button>}
      />
    );
  }

  function stub(area: HTMLTextAreaElement, reads: { n: number }) {
    Object.defineProperty(area, 'scrollHeight', {
      configurable: true,
      get() {
        reads.n += 1;
        return field(area.value.split('\n').length);
      },
    });
  }

  it('sizes the field to its draft and marks it capped past five lines', () => {
    const reads = { n: 0 };
    let setText: (next: string) => void = () => {};
    function Live() {
      const [text, set] = useState('one');
      setText = set;
      return <Host text={text} tick={0} />;
    }
    render(<Live />);
    const area = screen.getByRole('textbox') as HTMLTextAreaElement;
    stub(area, reads);
    act(() => setText('a\nb\nc'));
    expect(area.style.height).toBe('76px');
    expect(area.hasAttribute('data-capped')).toBe(false);
    act(() => setText('1\n2\n3\n4\n5\n6\n7'));
    expect(area.style.height).toBe('120px');
    expect(area.hasAttribute('data-capped')).toBe(true);
    act(() => setText(''));
    expect(area.style.height).toBe('32px');
    expect(area.hasAttribute('data-capped')).toBe(false);
  });

  it('does not re-measure on a render that leaves the draft alone (a streamed token)', () => {
    const reads = { n: 0 };
    const view = render(<Host text="hello" tick={0} />);
    const area = screen.getByRole('textbox') as HTMLTextAreaElement;
    stub(area, reads);
    for (let tick = 1; tick <= 5; tick += 1) view.rerender(<Host text="hello" tick={tick} />);
    expect(reads.n).toBe(0);
    view.rerender(<Host text={'hello\nworld'} tick={6} />);
    expect(reads.n).toBe(1);
    expect(area.style.height).toBe('54px');
  });
});
