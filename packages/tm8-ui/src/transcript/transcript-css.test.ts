/**
 * THE TRANSCRIPT SHEET, TESTED AS TEXT — because nothing else here can test it.
 *
 * jsdom loads no stylesheets, so a component test cannot see a double frame or
 * a copied rule. What this sheet must and must not contain is therefore
 * asserted against its text: no copy of chat's turn geometry (the turns are
 * chat's own component now), and no second frame around the composer card.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(fileURLToPath(new URL('./transcript.css', import.meta.url)), 'utf8');
/** Comments explain the rules and sometimes name what the rules must NOT do,
 *  so anything asserting on declarations reads this instead. */
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the transcript stylesheet', () => {
  /**
   * THE TURNS ARE CHAT'S, SO THIS SHEET HOLDS NO TURN GEOMETRY. It used to
   * carry a lifted copy of `.tch-turn` (`.tr-turn*`), and the cascade tests
   * that stood here guarded that copy's specificity. The copy drifted from chat
   * anyway, so it is gone: turns render through `chat-home/ChatTurn` and take
   * their rules from `chat-home.css`, whose own coverage tests guard them. A
   * rule reappearing here is a second copy starting to drift.
   */
  it('carries no copy of the chat turn geometry', () => {
    expect(RULES).not.toMatch(/\.tr-turn(?![s_])|\.tr-turn__(byline|body|truncated)/);
    expect(RULES).not.toMatch(/tch-turn|tch-user-body/);
  });

  /**
   * THE DOUBLE BOX, asserted where it can be. jsdom loads no stylesheets, so
   * every component test in this directory renders a composer whose card has no
   * border and cannot tell one frame from two. The user could: they circled it.
   * The rule's absence is therefore held against the stylesheet TEXT, which is
   * the same instrument the cascade assertions above use.
   */
  it('leaves the frame to the card — the foot draws no border of its own', () => {
    /* EVERY RULE THAT REACHES THE FOOT, not the first one that mentions it.
       Written as a first-match regex to begin with, and the negative control
       caught it: appending a SECOND `.tr-surface__foot { border-top: … }`
       restored the exact defect the user circled and reddened NOTHING, because
       the assertion never looked past the first block. A cascade is the sum of
       its rules, so the assertion has to be too. */
    const blocks = [...RULES.matchAll(/([^{}]*)\{([^}]*)\}/g)]
      .filter(([, selector]) => selector.includes('tr-surface__foot'));
    expect(blocks.length, '.tr-surface__foot must still exist — it owns the placement')
      .toBeGreaterThan(0);
    for (const [, selector, body] of blocks) {
      expect(body, `${selector.trim()} draws a second frame around the card`)
        .not.toMatch(/border|background|box-shadow/);
    }
  });

  // The retired paragraph. Its class going but a stale rule staying is how a
  // stylesheet accumulates dead weight that the next reader takes for live.
  it('keeps no rule for the disclosure paragraph that was removed', () => {
    expect(RULES).not.toMatch(/tr-surface__foot-note/);
    expect(RULES).not.toMatch(/\.tr-send\b/);
  });
});

/**
 * THE PROMOTED FOOT CONTROLS. They live in `rich-input.css` rather than here
 * because this became the THIRD surface to want chat's attach-and-Send
 * treatment, and `rich-input/index.ts` is the only module that reliably has its
 * stylesheet in the document. Asserted from this file because this is the
 * surface that depends on them.
 */
describe('the promoted composer foot controls', () => {
  const RI = readFileSync(
    fileURLToPath(new URL('../rich-input/rich-input.css', import.meta.url)),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  /**
   * THE #442 RULE, carried onto the shared class. Every other item in the foot
   * is a flex item with the automatic `min-width: auto` and so holds its
   * content width, which leaves Send the only item with any give: squeezed, its
   * label wraps to two lines and — `.ri-card` being `overflow: visible` — it
   * PAINTS over its neighbour rather than being clipped.
   */
  it('makes Send the one thing in the row that never gives', () => {
    const send = /\.ri-send\s*\{([^}]*)\}/.exec(RI);
    expect(send).not.toBeNull();
    expect(send![1]).toMatch(/flex:\s*none/);
    expect(send![1]).toMatch(/white-space:\s*nowrap/);
  });

  it('holds the attach control’s square against the same squeeze', () => {
    const attach = /\.ri-attach\s*\{([^}]*)\}/.exec(RI);
    expect(attach).not.toBeNull();
    expect(attach![1]).toMatch(/flex:\s*none/);
  });

  /**
   * The give is the SPACER, which has no content to protect — and the chain
   * has to be complete: `min-width: 0` on a strip does not make it
   * compressible when its CHILDREN carry the automatic `min-width: auto`.
   */
  it('gives the row its slack through the spacer, not through a control', () => {
    expect(RI).toMatch(/\.ri-foot-gap\s*\{[^}]*min-width:\s*0/);
  });

  /**
   * THE PHONE ANSWERS THE SAME SQUEEZE BY SCROLLING, on purpose, and a desktop
   * container rule that reached it would silently undo that ruling. This file
   * adds no narrow rules — asserted, so that adding one later without the
   * guard fails here rather than on a phone nobody is looking at.
   */
  it('adds no unguarded narrow rule that could undo the phone’s scrolling foot', () => {
    for (const block of RI.split('@container').slice(1)) {
      const head = block.slice(0, block.indexOf('}'));
      expect(head, `an @container rule in rich-input.css must exempt the phone: ${head}`)
        .toMatch(/:not\(\[data-shell='mobile'\]\)/);
    }
  });
});
