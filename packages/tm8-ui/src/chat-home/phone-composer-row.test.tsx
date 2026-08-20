// @vitest-environment jsdom
/**
 * THE PHONE'S COMPOSER ROW AND THE ENTITY TRAY — the four things reported on
 * task 01a01c91, one guard each.
 *
 * WHY HALF OF THIS READS A STYLESHEET. Three of the four are pure layout, and
 * jsdom loads no stylesheets and lays nothing out — every rect in this
 * environment is 0, and `getComputedStyle` returns the initial value for
 * anything a `<style>` tag did not set inline. There is no DOM assertion that
 * can see a 44px pill become 36, a hidden `.tch-pick__value`, or a row that
 * stopped overflowing. Asserting the SOURCE is not a substitute for the browser
 * measurement — that lives in `e2e/capture-chat-composer.mjs`, which put the
 * numbers at:
 *
 *     foot height       58 -> 50      pick trigger     44 -> 36
 *     strip overflow   152 -> 0       teammate name   101px -> gone
 *     tray             24px row -> absent
 *
 * across 320/360/390/430 with the desktop reading unchanged. This is the part
 * that runs in CI, and it fails the moment a declaration comes back.
 *
 * The FOURTH — the tray — is a component decision rather than a stylesheet one,
 * precisely so that it can be tested here and so that the chips are ABSENT
 * rather than hidden. That distinction is the whole reason it was done in TSX:
 * a `display: none` tray still mounts every chip, still runs every entity
 * resolution behind them, and still has to be remembered by the next person who
 * measures this row.
 *
 * Each `it` was seen to fail against the tree before the change; the note on
 * each says which line it hinges on, so the next person can break it again in
 * one edit rather than trusting a green run.
 */
import { readFileSync } from 'node:fs';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { MobileSurfaceProvider } from '../mobile';
import { EntityTray } from './EntityTray';
import type { ChatTurn, ChatTurnPart } from './types';

/* FROM THE CWD, not from `import.meta.url` — in a jsdom environment that URL
   resolves against the DOCUMENT base, not this directory. Same note as
   `phone-chat-defects.test.tsx`. */
const SRC = `${process.cwd()}/src`;
const RAW = readFileSync(`${SRC}/chat-home/chat-home.css`, 'utf8');
/* COMMENTS OUT FIRST, and both halves of that cost a round trip here.
   This file is more prose than CSS, so (a) a rule is preceded by `*​/` far more
   often than by `}`, which broke a "rule starts after the previous one ends"
   boundary, and (b) a guard asserting a selector is ABSENT matched the comment
   ABOVE the rule explaining why that selector was not used. A stylesheet guard
   must read declarations, not the argument for them. */
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block of the first rule whose selector matches `needle`. */
function ruleBody(needle: string): string {
  const at = CSS.indexOf(needle);
  expect(at, `no rule matching ${needle} in chat-home.css`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

/** Every rule in the file whose selector is EXACTLY `selector`, given RAW (this
 *  escapes it). A guard that reads only the first match is blind to the defect
 *  coming back in a second rule that overrides it, which is how a first-match
 *  assertion goes green on the regression it was written for — and it is not
 *  hypothetical here: the phone had two `.tch-picks` rules saying opposite
 *  things about `flex-wrap`, and asserting the first one read the arrangement
 *  that lost. Asserting the COUNT is what makes that visible. */
function rulesFor(selector: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(
    `^\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
    'gm',
  );
  for (const m of CSS.matchAll(pattern)) out.push(m[1] ?? '');
  return out;
}

let seq = 0;
const id = (n: number): string => `01900000-00dd-7000-8000-${String(n).padStart(12, '0')}`;

const call = (name: string, args: unknown, result?: unknown): ChatTurnPart[] => {
  const toolCallId = `tc-${(seq += 1)}`;
  const parts: ChatTurnPart[] = [
    { kind: 'tool_call', seq: (seq += 1), toolCallId, name, args, state: 'completed' },
  ];
  if (result !== undefined) {
    parts.push({ kind: 'tool_result', seq: (seq += 1), toolCallId, content: result });
  }
  return parts;
};

const turn = (parts: ChatTurnPart[]): ChatTurn => ({
  messageId: `msg-${(seq += 1)}` as EntityId,
  role: 'assistant',
  author: null,
  createdAt: '2026-08-20T10:00:00.000Z',
  body: '',
  parts,
});

/** A thread that has touched three entities — enough that a tray would draw. */
const TOUCHED = [
  turn([
    ...call('tm8_read_entity', { id: id(1) }, { id: id(1), kind: 'doc', title: 'A doc' }),
    ...call('tm8_create_entity', { id: id(2) }, { id: id(2), kind: 'task', title: 'A task' }),
    ...call('tm8_read_entity', { id: id(3) }, { id: id(3), kind: 'channel', title: 'A channel' }),
  ]),
];

describe('the stylesheet these guards read is actually parseable', () => {
  /**
   * THIS ONE EXISTS BECAUSE IT CAUGHT ME, and the failure it catches is one no
   * other test in this file can see.
   *
   * Editing the prose above a rule left a stray `*​/` after an already-closed
   * comment. Every source guard below stayed GREEN — they match text, and the
   * text was all still there — while the browser reported the pill back at its
   * base 24px, because the orphaned prose is a parse error and a real CSS
   * parser drops the rule that follows it.
   *
   * So: a source-regex guard cannot tell a declaration that APPLIES from one
   * that merely EXISTS. This is the cheapest thing that can, and this file is
   * ~60% prose, so the hazard is structural rather than a one-off slip.
   */
  it('has balanced comments, so no rule is orphaned by a stray terminator', () => {
    let depth = 0;
    for (let i = 0; i < RAW.length - 1; i += 1) {
      if (RAW.startsWith('/*', i) && depth === 0) depth = 1;
      else if (RAW.startsWith('*/', i) && depth === 1) depth = 0;
      else if (RAW.startsWith('*/', i) && depth === 0) {
        const line = RAW.slice(0, i).split('\n').length;
        expect.fail(`stray comment terminator at chat-home.css:${line} — the rule after it is dropped`);
      }
    }
    expect(depth, 'an unterminated comment swallows the rest of the file').toBe(0);
  });

  /** Comment stripping is what every guard below reads through, so a `{` or `}`
   *  left unbalanced by it would silently reshape every `ruleBody` result. */
  it('has balanced braces once the prose is stripped', () => {
    const open = (CSS.match(/\{/g) ?? []).length;
    const close = (CSS.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });
});

describe('the entity tray is absent on the phone', () => {
  /**
   * HINGES ON: `const chips = oneSurface ? [] : seeds` in `EntityTray`. Make it
   * `seeds` unconditionally and this reds.
   *
   * The reporter's words: "on top of the chat there are entity chips, many
   * chips in horizontal scroll ... remove those chips completely". What made it
   * a defect rather than a preference is that `MobileShell` wires no
   * entity-open handler, so `EntityChip` falls to its `<span>` branch and every
   * one of those chips was INERT.
   */
  it('renders no chips at all inside the phone surface', () => {
    const view = render(
      <MobileSurfaceProvider sheetHost={null}>
        <EntityTray turns={TOUCHED} />
      </MobileSurfaceProvider>,
    );
    expect(view.queryAllByTestId('chat-entity-chip')).toHaveLength(0);
  });

  /** With no stage tabs to draw either — which is what the phone passes — the
   *  whole row goes, rather than leaving an empty 24px band. */
  it('renders no tray row at all when the phone wires no stages', () => {
    const view = render(
      <MobileSurfaceProvider sheetHost={null}>
        <EntityTray turns={TOUCHED} />
      </MobileSurfaceProvider>,
    );
    expect(view.queryByTestId('chat-entity-tray')).toBeNull();
  });

  /** THE OTHER HALF OF THE RULING, and the one a blanket delete would have
   *  broken: on the desktop the same tray is wired and stays. */
  it('still renders the chips off the phone', () => {
    const view = render(<EntityTray turns={TOUCHED} />);
    expect(view.queryAllByTestId('chat-entity-chip').length).toBeGreaterThan(0);
  });

  /** It is the CHIPS that are gone and not the component: a phone host that
   *  did wire the stages would still get its tabs. Without this, replacing the
   *  gate with an unconditional `return null` would pass every test above. */
  it('keeps a phone host stage tabs while still drawing no chips', () => {
    const view = render(
      <MobileSurfaceProvider sheetHost={null}>
        <EntityTray turns={TOUCHED} onStage={() => {}} />
      </MobileSurfaceProvider>,
    );
    expect(view.queryAllByTestId('chat-entity-chip')).toHaveLength(0);
    expect(view.getByTestId('chat-entity-tray')).toBeTruthy();
    expect(view.getByRole('button', { name: /Fleet/ })).toBeTruthy();
  });
});

describe('the teammate trigger is an icon and a caret on the phone', () => {
  /**
   * HINGES ON: the `.cv2-root[data-shell='mobile'] .tch-pick--faced
   * .tch-pick__value` rule. Delete it and this reds.
   *
   * The reporter's words: "the teammate name should not be shown only the icon
   * and drop down". Measured at 101px of a 366px row before.
   */
  it('hides the faced trigger value on the phone', () => {
    const bodies = rulesFor(".cv2-root[data-shell='mobile'] .tch-pick--faced .tch-pick__value");
    expect(bodies.length, 'the phone rule that hides the faced value').toBe(1);
    expect(bodies[0]).toMatch(/display:\s*none/);
  });

  /** THE AVATAR IS WHY THIS IS SAFE, so the trigger that loses its word must be
   *  the one that draws a face. Keyed on `--faced` and not on the teammate's
   *  test id, so a mode or model picker can never lose its subject. */
  it('keys on the faced marker rather than the teammate picker', () => {
    const composer = readFileSync(`${SRC}/chat-home/ComposerSelect.tsx`, 'utf8');
    expect(composer).toMatch(/tch-pick--faced/);
    expect(composer).toMatch(/const faced = Boolean\(selected\?\.actor\)/);
    /* Not `[^{]*`: that crosses rule boundaries and matches a `[data-shell]`
       selector against a `tch-teammate` one twenty rules later. */
    expect(CSS).not.toMatch(/\[data-testid='tch-teammate'\]/);
  });

  /** The value never carried the accessible name — `aria-label` does, and
   *  `title` carries the selection — so hiding it costs assistive tech nothing.
   *  If either ever moves onto the value, this rule starts hiding a name. */
  it('leaves the name and the selection on the trigger itself', () => {
    const composer = readFileSync(`${SRC}/chat-home/ComposerSelect.tsx`, 'utf8');
    expect(composer).toMatch(/aria-label=\{label\}/);
    expect(composer).toMatch(/title=\{selected\?\.label\}/);
  });

  /** The desktop's own narrow-width version of this rule must stay guarded off
   *  the phone — #442's ruling is that the phone answers the squeeze by
   *  scrolling, and an unguarded container query would now fight this one. */
  it('leaves the desktop container query guarded off the phone', () => {
    expect(CSS).toMatch(
      /\.cv2-root:not\(\[data-shell='mobile'\]\) \.tch-pick--faced \.tch-pick__value/,
    );
  });
});

describe('the composer row is shorter and cannot overflow', () => {
  /**
   * HINGES ON: `min-block-size: 36px` in the phone's `.tch-pick__trigger` rule.
   * Put `var(--mobile-touch-min)` back and this reds.
   *
   * The reporter's words: "ask / plan widget is good, but its too height,
   * decrease its height a bit".
   */
  it('draws the thread-setting pills at 36px, not the 44px floor', () => {
    const bodies = rulesFor(".cv2-root[data-shell='mobile'] .tch-pick__trigger");
    expect(bodies.length, 'one rule per selector — see the note on rulesFor').toBe(1);
    expect(bodies[0]).toMatch(/min-block-size:\s*36px/);
  });

  /** THE FLOOR IS KEPT WHERE THE REPORT DID NOT ASK FOR IT TO MOVE. Send and
   *  Attach are the row's actions and a misfire on Send costs a message. If
   *  either ever drops below the token this says so. */
  it('keeps Send and the attach control on the 44px floor', () => {
    const send = ruleBody(".cv2-root[data-shell='mobile'] .tch-send,");
    expect(send).toMatch(/min-block-size:\s*var\(--mobile-touch-min\)/);
    expect(send).toMatch(/min-inline-size:\s*var\(--mobile-touch-min\)/);
    const attach = ruleBody(".cv2-root[data-shell='mobile'] .ri-card__foot .hon-disabled");
    expect(attach).toMatch(/block-size:\s*var\(--mobile-touch-min\)/);
    expect(attach).toMatch(/inline-size:\s*var\(--mobile-touch-min\)/);
  });

  /** The refused-attach control was the tallest thing in the row at 50px, and
   *  it was 50 because this package has no border-box reset. Drop the
   *  `box-sizing` and the pin becomes a CONTENT height and the 6px returns. */
  it('sizes the refused-attach control border-box, or the pin does nothing', () => {
    const attach = ruleBody(".cv2-root[data-shell='mobile'] .ri-card__foot .hon-disabled");
    expect(attach).toMatch(/box-sizing:\s*border-box/);
  });

  /**
   * HINGES ON: `overscroll-behavior-x: contain` on the phone's `.tch-picks`.
   *
   * Without it a horizontal flick that reaches either end of the settings strip
   * CHAINS to the ancestor — so an overshoot drags the transcript, and a swipe
   * off the left edge can fire the browser's back gesture and take the writer's
   * draft with it. This is the "make it smooth" half of the report and it is
   * the one property no screenshot can show.
   */
  it('contains the settings strip’s own scroll', () => {
    const picks = ruleBody(".cv2-root[data-shell='mobile'] .tch-picks {");
    expect(picks).toMatch(/overscroll-behavior-x:\s*contain/);
    expect(picks).toMatch(/scroll-snap-type:\s*x proximity/);
  });

  /** The strip must stay a SCROLLER rather than becoming a wrapper: wrapping
   *  buys width back by spending height, which is the trade this row is being
   *  asked to stop making. */
  it('keeps the strip one non-wrapping scrolling line', () => {
    const picks = ruleBody(".cv2-root[data-shell='mobile'] .tch-picks {");
    expect(picks).toMatch(/flex-wrap:\s*nowrap/);
    expect(picks).toMatch(/overflow-x:\s*auto/);
    const foot = ruleBody(".cv2-root[data-shell='mobile'] .ri-card__foot {");
    expect(foot).toMatch(/flex-wrap:\s*nowrap/);
  });

  /** A trigger that can take 150px of a 366px card is how three of them stop
   *  fitting however hard the strip scrolls. */
  it('caps a trigger below half the phone card', () => {
    const bodies = rulesFor(".cv2-root[data-shell='mobile'] .tch-pick__trigger");
    const max = /max-width:\s*(\d+)px/.exec(bodies[0] ?? '');
    expect(max, 'the phone cap on a thread-setting trigger').toBeTruthy();
    expect(Number(max?.[1])).toBeLessThanOrEqual(120);
  });
});
