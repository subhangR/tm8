import type { ReactNode } from 'react';

/**
 * THE DESIGNED REFUSAL CARD — the one the authoring canvas actually draws.
 *
 * T5-5's own eyebrow over it reads "DESIGNED REFUSAL — NOT A TOAST APOLOGY",
 * and its annotation states the grammar in four parts:
 *
 *   "red word + cause + what did NOT happen + real next moves"
 *
 * Its drawn example is worth quoting because the SECOND HALF of the body is
 * the part a normal error component omits: "The node allows 8 concurrent
 * sessions and 8 are in use. Nothing was started; your picks are kept right
 * here." The user is told what survived, not only what failed — which is why
 * `aftermath` is a required prop rather than something a caller may forget.
 *
 * MEASURED FROM THE ORACLE (T5-5 refusal block, and the values are tokens
 * because every one of them already has a name):
 *   card    background #FBFAF6 → --pn-surface · radius 10px · padding 12px 14px · gap 8px
 *   dot     9px round, #BB4D3D → --pn-block
 *   word    12.5px/600, #BB4D3D → --pn-block
 *   body    11.5px/1.55, #5B564C → --pn-ink-2, text-wrap: pretty
 *   moves   mono 9.5px, #8E897B → --pn-ink-3, 1px #D8D3C6 → --pn-line-2, r6,
 *           2px 9px, #FFFFFF → --pn-card, hover #F2EFE8 → --pn-hover
 *   note    mono 9.5px, #B7B2A4 → --pn-ink-4, align-self center
 *
 * ONE MEASURED VALUE IS DELIBERATELY NOT COPIED: the oracle's card carries
 * `border:1px solid #2C2719` and a heavy shadow because it is drawn ON THE
 * DARK PRESENTATION BOARD. Inside a light panel that hex is the dark line
 * token, which would render as a near-black frame. The hairline rule decides
 * it without guessing: --pn-line BOUNDS a component and a card is a component,
 * so the border is --pn-line and inverts with the theme for free.
 *
 * `role="alert"` because a refusal that only appears is a refusal a screen
 * reader user learns about by accident.
 */
export interface RefusalMove {
  label: string;
  onSelect(): void;
}

export function RefusalCard({
  word,
  detail,
  aftermath,
  note,
  moves = [],
  children,
  testId = 'authoring-refusal',
}: {
  /** The red line. */
  word: string;
  /** Why — the server's own sentence wherever there is one. */
  detail: string;
  /** What did NOT happen, and where the user's work is. */
  aftermath?: string;
  /** The quiet trailing truth ("no queue in v1 — honestly"). */
  note?: string;
  moves?: readonly RefusalMove[];
  /** Extra moves that are themselves disabled-with-reason. */
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="au-refusal" role="alert" data-testid={testId}>
      <div className="au-refusal__head">
        <span className="au-refusal__dot" aria-hidden />
        <span className="au-refusal__word">{word}</span>
      </div>
      <div className="au-refusal__body">
        {detail}
        {aftermath ? ` ${aftermath}` : null}
      </div>
      {moves.length > 0 || children || note ? (
        <div className="au-refusal__moves">
          {moves.map((move) => (
            <button key={move.label} type="button" className="au-refusal__move" onClick={move.onSelect}>
              {move.label}
            </button>
          ))}
          {children}
          {note ? <span className="au-refusal__note">{note}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
