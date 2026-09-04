/**
 * NEW SESSION — turning a typed prompt into a task title.
 *
 * THE WHOLE POINT is that the user names nothing. They type what they want
 * done and press Enter; the first sentence becomes the task's title and the
 * prompt itself becomes the body, verbatim and complete. So this function is
 * only ever allowed to LOSE characters from the title, never from the work:
 * `deriveTitle` is cosmetic, and `promptBody` is the contract.
 *
 * WHY NOT "Untitled task". The rest of the app creates a task with a
 * placeholder and lets the SAVE flow name it (authoring/useNewTask.ts). That
 * is right for a create whose next step is an editor. It is wrong here: this
 * create's next step is a running agent, nobody is coming back to rename it,
 * and a list full of "Untitled task" is what that would produce. An empty
 * prompt is refused at the composer instead — see `canDeriveTitle`.
 */

/**
 * The ceiling for a derived title. Long enough for a real sentence, short
 * enough to survive a list row without the row deciding where to cut it.
 */
export const TITLE_MAX = 80;

/** Sentence terminators, plus the newline — a line break ends a thought too. */
const SENTENCE_END = /[.!?\n]/;

/**
 * Whether this prompt can name a task at all.
 *
 * Whitespace-only is the only refusal. It exists so the composer can withhold
 * Enter with a reason rather than minting a nameless task nobody will fix.
 */
export function canDeriveTitle(prompt: string): boolean {
  return prompt.trim().length > 0;
}

/**
 * The first sentence of `prompt`, bounded to `TITLE_MAX`.
 *
 * TRUNCATION IS LOSSLESS HERE and that is the design: the full prompt is
 * always stored as the task body by `promptBody`, so a cut title costs
 * nothing but a shorter label. That is why this can afford to be aggressive
 * rather than clever — no summarisation, no ellipsis-in-the-middle, no
 * attempt to be smart about what the user "meant".
 *
 * Returns `''` for a prompt that cannot name anything; callers gate on
 * `canDeriveTitle` first and never ship an empty title to `entities.create`,
 * whose schema requires `min(1)`.
 */
export function deriveTitle(prompt: string): string {
  const text = prompt.trim();
  if (text.length === 0) return '';

  // The first sentence, or the whole thing when the user never terminated one.
  const end = text.search(SENTENCE_END);
  let title = (end === -1 ? text : text.slice(0, end)).trim();

  // A prompt opening with punctuation ("...ok so", "!!") can search to 0 and
  // leave nothing. Fall back to the unsplit text rather than returning empty
  // and tripping the schema's min(1) at the node.
  if (title.length === 0) title = text;

  if (title.length <= TITLE_MAX) return title;

  // Cut on a word boundary when there is one in the last quarter — cutting
  // mid-word reads like a bug, whereas a clean word break reads like a
  // deliberate summary. The quarter bound stops a single long token from
  // collapsing the title to almost nothing.
  const hard = title.slice(0, TITLE_MAX);
  const lastSpace = hard.lastIndexOf(' ');
  const cut = lastSpace > TITLE_MAX * 0.75 ? hard.slice(0, lastSpace) : hard;
  return `${cut.trimEnd()}…`;
}

/**
 * The task body: the prompt, verbatim.
 *
 * Trimmed at the edges and otherwise untouched — no reflowing, no collapsing
 * of blank lines, no normalisation. This string is what the agent receives as
 * its first turn (rendered by prompt/templates.ts as the task assignment), so
 * every transformation applied here is a transformation applied to someone's
 * instructions. The safest edit is none.
 */
export function promptBody(prompt: string): string {
  return prompt.trim();
}
