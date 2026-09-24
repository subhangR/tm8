/**
 * THE EMPTY STATE THAT TEACHES. An empty studio used to say "An empty
 * blueprint. Ask the craft chat to sketch nodes and edges" — which assumes the
 * reader already knows what a blueprint is, what a node is, and what to ask.
 *
 * This says what a blueprint IS (a plan drawn before anything is created),
 * shows the four things it is made of in the shapes the canvas will draw
 * them, and offers example prompts that land in the composer — the reader
 * edits and sends; nothing is sent on their behalf.
 */
export const EXAMPLE_PROMPTS: readonly string[] = [
  'Plan a launch for our new pricing page: research, copy, design review and the ship checklist.',
  'Break "migrate auth to passkeys" into tasks, who should own each, and the docs they produce.',
  'Design a weekly research digest: a teammate that reads sources, writes a doc, and remembers what it covered.',
];

export function CraftEmptyState({
  hasGraph,
  onPrompt,
  onCreate,
}: {
  /** False ⇒ the space has no blueprint yet; the primary action is to make one. */
  hasGraph: boolean;
  /** Present ⇒ the examples fill the composer. */
  onPrompt?: ((text: string) => void) | undefined;
  onCreate?: (() => void) | undefined;
}) {
  return (
    <div className="crf-teach" data-testid={hasGraph ? 'crf-empty' : 'crf-no-graph'}>
      <svg className="crf-teach__art" width={240} height={72} viewBox="0 0 240 72" aria-hidden>
        <path className="crf-teach__edge" d="M52 36 H84" />
        <path className="crf-teach__edge" d="M156 36 H188" />
        <rect className="crf-teach__doc" x={4} y={20} width={48} height={32} rx={4} />
        <rect className="crf-teach__task" x={86} y={16} width={68} height={40} rx={8} />
        <circle className="crf-teach__avatar" cx={144} cy={56} r={7} />
        <rect className="crf-teach__memory" x={190} y={24} width={46} height={24} rx={12} />
      </svg>
      <h2 className="crf-teach__title">{hasGraph ? 'An empty blueprint' : 'Plan the work before it exists'}</h2>
      <p className="crf-teach__lead">
        A blueprint is a plan you draw with the craft agent: the <strong>tasks</strong>, the <strong>teammates</strong> who
        own them, the <strong>docs and artifacts</strong> they need and make, and what they should <strong>remember</strong>.
        Nothing is created until you press <strong>Orchestrate</strong>.
      </p>
      {onPrompt ? (
        <>
          <p className="crf-teach__try">Try asking:</p>
          <ul className="crf-teach__prompts">
            {EXAMPLE_PROMPTS.map((prompt) => (
              <li key={prompt}>
                <button type="button" className="crf-teach__prompt" data-testid="crf-example" onClick={() => onPrompt(prompt)}>
                  {prompt}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {!hasGraph && onCreate ? (
        <button type="button" className="crf-btn crf-btn--primary" data-testid="crf-teach-new" onClick={onCreate}>
          ＋ New blueprint
        </button>
      ) : null}
    </div>
  );
}

/**
 * The CHAT's new-conversation intro in Craft — in place of the generic
 * "Evening." greeting, which said nothing about what this agent does here.
 */
export function CraftChatIntro({ onPrompt }: { onPrompt(text: string): void }) {
  return (
    <div className="crf-intro" data-testid="crf-chat-intro">
      <h1>Craft a plan</h1>
      <p>
        Describe the work. The craft agent drafts the blueprint on the right — tasks, who owns them, what they need
        and make — and revises it with you, one change at a time. Select a node to ask about it.
      </p>
      <ul className="crf-intro__prompts">
        {EXAMPLE_PROMPTS.slice(0, 2).map((prompt) => (
          <li key={prompt}>
            <button type="button" className="crf-teach__prompt" onClick={() => onPrompt(prompt)}>{prompt}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
