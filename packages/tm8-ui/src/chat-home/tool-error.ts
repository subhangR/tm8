/**
 * WHY A FAILED TOOL CALL SAYS WHY.
 *
 * A tool card used to render one of three sentences when a call failed —
 * "Output was not created.", "Document was not updated.", "This presentation
 * could not be prepared." — and nothing else. The reason the server gave was
 * dropped on the floor.
 *
 * That is not a cosmetic loss. On 2026-08-22 an agent tried to publish an
 * artifact, the call was rejected with `manifest.files needs objects`, and the
 * card said only "Output was not created." The agent moved on to the next task
 * without retrying, and the human watching had no way to tell a malformed call
 * from a dead backend. The reason reached them only because the agent happened
 * to paste it into prose. A surface that hides the one fact that makes a
 * failure actionable turns a schema typo into a mystery.
 *
 * So this module answers ONE bounded question: given a tool result the model
 * marked as an error, what is the shortest true sentence about why?
 *
 * WHAT THE PAYLOAD LOOKS LIKE. There is no single shape, which is precisely
 * why this lives in one place rather than being re-guessed at each call site.
 * MCP results arrive as tm8's own `{schemaVersion, error:{code,message}}`
 * envelope, as an Anthropic `content: [{type:'text', text}]` block whose text
 * is itself JSON, as a bare string, or as a plain `{message}` / `{error}`
 * object. Each is unwrapped here; anything unrecognised yields `null` and the
 * caller keeps its existing generic sentence, which is the honest fallback.
 *
 * BOUNDED ON PURPOSE. The search is shallow (`MAX_DEPTH`) and the message is
 * truncated (`MAX_MESSAGE_CHARS`). A tool card is a glance, not a log viewer:
 * a stack trace pasted into the transcript would push the conversation off
 * screen and bury the sentence it came to deliver. The full payload remains
 * available wherever raw results are inspected — this is the summary line.
 */

/** Deep enough for `{content:[{text:'{"error":{...}}'}]}`, no deeper. */
const MAX_DEPTH = 6;

/**
 * One line, not a log. Long enough for a real validation sentence —
 * `manifest.files needs objects` is 28 — and short enough that a card stays a
 * card. Truncation is marked with an ellipsis so a clipped message never reads
 * as a complete one.
 */
const MAX_MESSAGE_CHARS = 240;

export interface ToolFailureReason {
  /** A machine code such as `invalid_input`, when the payload carried one. */
  code?: string;
  /** Human-readable reason, trimmed and length-capped. Never empty. */
  message: string;
}

/**
 * Pull the reason out of a failed tool call's result.
 *
 * Returns `null` when the payload carries no usable sentence — the caller then
 * keeps its own generic wording rather than inventing a reason.
 */
export function toolFailureReason(result: unknown): ToolFailureReason | null {
  const found = search(result, 0);
  if (!found) return null;
  const message = clip(found.message);
  if (!message) return null;
  return found.code ? { code: found.code, message } : { message };
}

function search(value: unknown, depth: number): ToolFailureReason | null {
  if (depth > MAX_DEPTH || value === null || value === undefined) return null;

  if (typeof value === 'string') return fromString(value, depth);
  if (Array.isArray(value)) {
    /* An MCP content array: first block that yields a reason wins, so a
       leading empty text block cannot mask the error block behind it. */
    for (const entry of value) {
      const found = search(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;

  /* tm8's own envelope, and the common `{error: {...}}` nesting. A string
     `error` is itself the sentence — `{error: 'not found'}` is a real shape. */
  const error = record.error;
  if (typeof error === 'string' && error.trim()) {
    return { message: error, ...(stringField(record.code) ? { code: stringField(record.code)! } : {}) };
  }
  if (error && typeof error === 'object') {
    const nested = search(error, depth + 1);
    if (nested) return nested;
  }

  /* A message beside an optional code — the terminal shape of every envelope
     above, and what a bare `{code, message}` result already is. */
  const message = stringField(record.message) ?? stringField(record.detail) ?? stringField(record.reason);
  if (message) {
    const code = stringField(record.code);
    return code ? { code, message } : { message };
  }

  /* An Anthropic content block: `{type:'text', text:'…'}`. The text is often
     JSON, so it goes back through `fromString` rather than being taken raw. */
  const text = stringField(record.text);
  if (text) return fromString(text, depth + 1);

  /* A wrapper such as `{content: […]}` or `{structuredContent: {…}}`. */
  for (const key of ['content', 'structuredContent', 'data', 'result'] as const) {
    if (record[key] !== undefined) {
      const found = search(record[key], depth + 1);
      if (found) return found;
    }
  }

  return null;
}

/**
 * A string is either JSON worth unwrapping or the sentence itself. Parsing is
 * attempted only when it looks like JSON, and a parse failure falls back to
 * treating the string as prose — never to discarding it.
 */
function fromString(raw: string, depth: number): ToolFailureReason | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[[{]/.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const found = search(parsed, depth + 1);
      if (found) return found;
    } catch {
      /* Not JSON after all; the raw string is still a usable sentence. */
    }
  }
  return { message: trimmed };
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function clip(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length <= MAX_MESSAGE_CHARS ? flat : `${flat.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}
