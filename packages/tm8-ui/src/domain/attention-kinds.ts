/**
 * Attention v2 — the two kind facts the attention surfaces need (chapter 4),
 * kept here because kind literals live in domain/ (§15.2).
 *
 * · An ASKER is a kind that raises requests of its own: a work session or a
 *   chat (F1). Its tile carries `waiting on you: …` and its detail shows the
 *   banner for what it raised.
 * · A FORM rolled up onto a task gets **Answer form** in the detail block.
 */
const ASKERS: ReadonlySet<string> = new Set(['work_session', 'chat']);

export function raisesAttention(kind: string | null | undefined): boolean {
  return kind != null && ASKERS.has(kind);
}

export function isAnswerableForm(kind: string | null | undefined): boolean {
  return kind === 'form';
}
