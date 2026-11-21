/**
 * The chat paste guard (Secure Vault brief v2, MSG 6 Journey A step 3; task 01a1fa87-dd1a, WS-A).
 *
 *   "If a user pastes something secret-shaped into chat (card number, "password is ...", API key
 *   pattern), detection is best-effort: refuse to store it in the vault, warn that the message
 *   already lives in chat history and the provider's systems regardless of refusal, offer the
 *   capture link, and flag the item for rotation on import. Never claim refusal means nothing was
 *   stored upstream."
 *
 * TM8_VAULT_PASTE_GUARD=on turns it on (vault/config.ts). Off, the default, changes nothing. On, it
 * reads text a PERSON wrote, before tm8 stores it:
 *   - messages.post with neither a session nor a chat source, i.e. a person's own credential;
 *   - messages.edit by such an author. A secret-shaped edit is refused rather than rewritten: the
 *     edit result has no warnings channel, and the message keeps its earlier text;
 *   - chat.start (people only): the opening message and the title;
 *   - a bridged message from a person (not a bot or app): its body, a slash command's text and each media caption.
 * It replaces each secret-shaped span with `[redacted:<kind>]`. The caller says so: a
 * `vault_paste_redacted` warning on the result, or a notice in a bridged chat. The vault stores
 * nothing, and no text in this file repeats a value.
 *
 * WHAT IT DOES NOT CLAIM. The text has left the person's device. A bridged message stays in the chat
 * and with the provider, and a web post crossed the network and this process's memory. The warning
 * says so and tells the owner to rotate. "Flag the item for rotation on import" is the owner's
 * import choice: tier a, which stays blocked until rotated. The guard keeps nothing derived from the
 * value, so nothing in tm8 could flag it.
 *
 * Agent-authored text is not scanned. Agents never hold vault plaintext (MSG 5 A), and the vault's
 * own path filters what reaches them.
 *
 * DETECTION is the vault's paste detector (@tm8/vault/paste), which reports every candidate. This
 * guard redacts only the candidates that ordinary messages rarely trip:
 *   - every high-confidence kind (provider keys, private keys, credential and webhook URLs, JWTs,
 *     card numbers), and an AWS secret key next to an access key;
 *   - `password = | : | is <value>` when the value looks like a password, not a word, a
 *     placeholder or a reference (`passwordValue`);
 *   - `<secret|token|api_key|...> = | : <value>` and signed-URL signatures when the value is 16 or
 *     more characters with letters and digits, and not a URL, path, placeholder or reference
 *     (`secretValue`). Sharing a signed URL therefore redacts its signature: send the file instead.
 * A bare high-entropy string is never redacted: ids, hashes and paths fill ordinary messages.
 */
import {
  CollabError,
  VAULT_PASTE_WARNING_CODE,
  type InboundFrame,
  type ResultWarning,
  type StartChatInput,
} from '@tm8/contract';
import { createPasteDetector, type PasteFinding, type PasteKind } from '@tm8/vault/paste';

export type { PasteKind } from '@tm8/vault/paste';

/** The longest message body: PostMessageInputSchema, StartChatInputSchema and messages.body's check. */
export const MESSAGE_BODY_MAX = 10_000;
/** The longest chat title StartChatInputSchema accepts. */
export const CHAT_TITLE_MAX = 240;

/** What a person sees for each kind, in a warning or a bridge notice. */
const LABELS: Record<PasteKind, string> = {
  private_key: 'private key',
  aws_access_key: 'AWS access key',
  aws_secret_key: 'AWS secret key',
  github_token: 'GitHub token',
  gitlab_token: 'GitLab token',
  openai_key: 'OpenAI key',
  anthropic_key: 'Anthropic key',
  google_api_key: 'Google API key',
  slack_token: 'Slack token',
  stripe_key: 'Stripe key',
  twilio_key: 'Twilio key',
  tm8_token: 'tm8 token',
  jwt: 'JWT',
  connection_string: 'credential URL',
  webhook_url: 'webhook URL',
  card_number: 'card number',
  password_assignment: 'password',
  generic_secret_assignment: 'secret value',
  high_entropy: 'random-looking string',
};

/** Sentence punctuation after a value: `password is hunter2.` reads the value as `hunter2`. */
const TRAILING_PUNCTUATION = /[.!?:;,)\]}'"]+$/u;
/** Words that stand for a value in docs, schemas and prose, never one. Compared lowercased. */
const PLACEHOLDER_WORDS = new Set([
  'null', 'none', 'nil', 'undefined', 'true', 'false', 'empty', 'redacted', 'hidden', 'secret', 'password', 'passwd',
  'changeme', 'example', 'placeholder', 'required', 'optional', 'string', 'str', 'text', 'number', 'int', 'bool',
  'boolean', 'any', 'unknown', 'bytes', 'secretstr', 'secretstring', 'todo', 'tbd', 'xxx', 'n/a',
]);
/**
 * A template or variable in place of the value: `$DB_PASSWORD`, `${PW}`, `${{ secrets.X }}` (cut at its
 * first space), `{{ .Values.pw }}`, `<password>`, `%PW%`, `[REDACTED]`. An opener, a run of name
 * characters and at most the closer, so `$ecr3t!` is not one. Tested on the untrimmed value.
 */
const TEMPLATE = /^(?:\$\{\{?|\{\{?|\$|<|%|\[)[\w\s.-]*(?:\}\}?|>|%|\])?[.,;:]?$/u;
/** A digit, in any script. */
const DIGIT = /\p{Nd}/u;
/** A letter, in any script. */
const LETTER = /\p{L}/u;
/** A character a password has and a word does not. Combining marks and joiners are letters (Telugu, Hindi). */
const SYMBOL = /[^\p{L}\p{M}\p{N}\s'.\u200c\u200d-]/u;

/** A placeholder, a masked value or a word that stands for one. `value` is already trimmed. */
function placeholder(raw: string, value: string): boolean {
  return value === '' || /^[*xX._#-]+$/u.test(value) || PLACEHOLDER_WORDS.has(value.toLowerCase())
    || /^your/iu.test(value) || TEMPLATE.test(raw);
}

/** Code that names where the value lives: `getenv(`, `config.db.password`, `os.environ[`, `DB_PASSWORD`. */
function reference(value: string): boolean {
  return value.includes('(') || /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u.test(value) || /^[A-Za-z_][\w.]*\[/u.test(value)
    || /^[A-Z][A-Z0-9_]*_[A-Z0-9_]+$/u.test(value);
}

/**
 * `password is hunter2`, `pwd: "letmein"`, `password=Tr0ub4dor&3`: a value with a digit or a symbol, a quoted
 * value of six or more characters, or one of twenty or more. Not a word (`password is optional`), not prose
 * about a number (`password is 8 characters`, `password is 90-day rotated`), not a placeholder or reference.
 */
function passwordValue(raw: string, quoted: boolean): boolean {
  const value = raw.replace(TRAILING_PUNCTUATION, '');
  if (placeholder(raw, value) || reference(value) || /^\p{Nd}+(?:-\p{L}+)+$/u.test(value)) return false;
  const length = [...value].length;
  return (length >= 4 && (DIGIT.test(value) || SYMBOL.test(value))) || (quoted && length >= 6) || length >= 20;
}

/**
 * `api_key = "f3a9…"`, `token: 9c1e…`, a URL's `sig=`: a value of sixteen or more characters with letters and
 * digits. Not a URL, a file path or a resource name (`projects/p/secrets/db`), a placeholder or a reference.
 */
function secretValue(raw: string): boolean {
  const value = raw.replace(TRAILING_PUNCTUATION, '');
  if (placeholder(raw, value) || reference(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) || /^(?:~|\.{1,2})?\/[\w./-]+$/u.test(value)
    || /^[a-z0-9._-]+(?:\/[a-z0-9._-]+){2,}$/u.test(value)) return false;
  return [...value].length >= 16 && LETTER.test(value) && DIGIT.test(value);
}

/**
 * Whether one merged finding is redacted. A merged finding takes the kind of its strongest member, so an
 * assignment kind means no high-confidence finding overlapped it, and its span is the assignment's value:
 * the detector starts the value after an opening quote and ends it before the closing one.
 */
function redactable(text: string, finding: PasteFinding): boolean {
  const { kind } = finding;
  switch (kind) {
    case 'private_key': case 'aws_access_key': case 'aws_secret_key': case 'github_token': case 'gitlab_token':
    case 'openai_key': case 'anthropic_key': case 'google_api_key': case 'slack_token': case 'stripe_key':
    case 'twilio_key': case 'tm8_token': case 'jwt': case 'connection_string': case 'webhook_url': case 'card_number':
      return true;
    case 'password_assignment': {
      const before = text[finding.start - 1];
      const quoted = (before === '"' || before === "'") && text[finding.end] === before;
      return passwordValue(text.slice(finding.start, finding.end), quoted);
    }
    case 'generic_secret_assignment':
      return secretValue(text.slice(finding.start, finding.end));
    case 'high_entropy':
      return false;
    default: {
      // A kind this build does not know (a newer detector) is redacted: the guard fails toward privacy.
      const unhandled: never = kind;
      void unhandled;
      return true;
    }
  }
}

export interface PasteRedaction {
  /** The text with each redacted span replaced. The input itself when `kinds` is empty. */
  readonly text: string;
  /** The kinds redacted, distinct, in the order they first appear. Empty: nothing was redacted. */
  readonly kinds: readonly PasteKind[];
  /**
   * False when even the short `[redacted]` marker leaves `text` longer than the limit the caller passed.
   * A message is then refused (`tooLong`); a title is dropped; a bridged body is cut by SQL, as any is.
   */
  readonly fits: boolean;
}

export interface PasteGuard {
  /** Replaces the secret-shaped spans in one text. `maxLength` is the field's limit in UTF-16 units. */
  redact(text: string, maxLength?: number): PasteRedaction;
  /** The warning a post or chat start returns when it stored redacted text. */
  warning(kinds: readonly PasteKind[]): ResultWarning;
  /** The refusal of a person's edit that holds secret-shaped text. */
  editRefusal(kinds: readonly PasteKind[]): CollabError;
  /** The refusal of a message that redaction would push past its limit. */
  tooLong(kinds: readonly PasteKind[]): CollabError;
  /** The notice tm8 posts in a bridged chat after it redacted a person's message. */
  bridgeNotice(kinds: readonly PasteKind[]): string;
}

export interface PasteGuardOptions {
  /**
   * Whether this node runs the vault (TM8_VAULT_MODE is not off). Off, the advice is to rotate and keep the
   * new value out of chat, because the Secure vault settings page has nothing to offer.
   */
  readonly vaultAvailable: boolean;
}

/** `password, GitHub token`: the labels of the kinds redacted. Never a value. */
function labelsOf(kinds: readonly PasteKind[]): string {
  return [...new Set(kinds)].map((kind) => LABELS[kind] ?? 'secret').join(', ');
}

function splice(text: string, findings: readonly PasteFinding[], marker: (finding: PasteFinding) => string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const finding of findings) {
    parts.push(text.slice(cursor, finding.start), marker(finding));
    cursor = finding.end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

export function createPasteGuard(options: PasteGuardOptions): PasteGuard {
  const detector = createPasteDetector();
  const rotate = options.vaultAvailable
    ? 'rotate it at the source, then add the new value through a Secure Vault capture link (Settings → Secure vault).'
    : 'rotate it at the source, and keep the new value out of chat.';
  const importNote = options.vaultAvailable ? ' If you import the old value, mark it tier a: it stays blocked until rotated.' : '';
  const refusal = (message: string, kinds: readonly PasteKind[]) => new CollabError('invalid_input', message, {
    details: { reason: VAULT_PASTE_WARNING_CODE, kinds: [...new Set(kinds)] },
  });
  return {
    redact(text, maxLength = Number.POSITIVE_INFINITY) {
      if (text === '') return { text, kinds: [], fits: true };
      // Merged findings are sorted and disjoint (packages/vault/src/paste merge()).
      const findings = detector.scan(text).findings.filter((finding) => redactable(text, finding));
      if (findings.length === 0) return { text, kinds: [], fits: text.length <= maxLength };
      const kinds = [...new Set(findings.map((finding) => finding.kind))];
      const labelled = splice(text, findings, (finding) => `[redacted:${finding.kind}]`);
      if (labelled.length <= maxLength) return { text: labelled, kinds, fits: true };
      const short = splice(text, findings, () => '[redacted]');
      return { text: short, kinds, fits: short.length <= maxLength };
    },
    warning(kinds) {
      return {
        code: VAULT_PASTE_WARNING_CODE,
        message: `That message looked like it held a secret (${labelsOf(kinds)}). tm8 replaced it with [redacted] before `
          + 'storing it, and the vault never stores a secret sent in chat. Treat it as exposed anyway: it left your device, and '
          + `other secrets in the message may not have been caught. To be safe, ${rotate}${importNote}`,
      };
    },
    editRefusal(kinds) {
      return refusal(`That edit looked like it held a secret (${labelsOf(kinds)}), so tm8 did not save it and the message `
        + 'keeps its previous text. The vault never stores a secret sent in chat. Treat it as exposed anyway: it left your '
        + `device. To be safe, ${rotate}`, kinds);
    },
    tooLong(kinds) {
      return refusal(`That message looked like it held a secret (${labelsOf(kinds)}), and with it removed the message is too `
        + 'long to store, so tm8 did not store it. Treat it as exposed anyway: it left your device. To be safe, '
        + `${rotate} Then send the message again without it.`, kinds);
    },
    bridgeNotice(kinds) {
      return `That message looked like it held a secret (${labelsOf(kinds)}). tm8 removed it before storing the message, `
        + 'and the vault never stores a secret sent in chat. The message is still in this chat and with the chat provider, so '
        + `treat the secret as exposed: ${options.vaultAvailable
          ? 'rotate it at the source, then add the new value in tm8 under Settings → Secure vault.'
          : 'rotate it at the source, and keep the new value out of chat.'}`;
    },
  };
}

/** The kinds of several redactions, distinct, in order. */
export function redactedKinds(...redactions: readonly (PasteRedaction | null | undefined)[]): PasteKind[] {
  return [...new Set(redactions.flatMap((redaction) => redaction?.kinds ?? []))];
}

/**
 * chat.start's opening message and title, both written by the person starting the chat (the op is people-only).
 * The start is refused when the redacted body no longer fits. A redacted title that no longer fits is dropped, and
 * the chat takes its default title from the redacted body. `warning` is null when nothing was redacted, and then
 * `input` is the input itself.
 */
export function guardChatStart(guard: PasteGuard, input: StartChatInput): { readonly input: StartChatInput; readonly warning: ResultWarning | null } {
  const body = guard.redact(input.body, MESSAGE_BODY_MAX);
  const title = typeof input.title === 'string' ? guard.redact(input.title, CHAT_TITLE_MAX) : null;
  const kinds = redactedKinds(body, title);
  if (kinds.length === 0) return { input, warning: null };
  if (!body.fits) throw guard.tooLong(kinds);
  return {
    input: {
      ...input,
      body: body.text,
      ...(title && title.kinds.length > 0 ? { title: title.fits ? title.text : null } : {}),
    },
    warning: guard.warning(kinds),
  };
}

/**
 * A bridged message, when a person wrote it: a sender id, and not a bot or app. Its body, a slash command's text and
 * each media caption are redacted, in a new message and in an edit: the store keeps captions with the message and
 * takes them as the body when there is none. Nothing is refused: the message already sits in the chat and with the
 * provider, and a body the markers push past the limit is cut by the store, as any body is. A deleted message has no
 * text. `kinds` is empty when nothing was redacted, and then `frame` is the frame itself.
 */
export function guardInboundFrame(guard: PasteGuard, frame: InboundFrame): { readonly frame: InboundFrame; readonly kinds: readonly PasteKind[] } {
  if (frame.deleted === true || typeof frame.sender?.externalId !== 'string' || frame.sender.bot === true) {
    return { frame, kinds: [] };
  }
  // The runtimes always send a string body, as the contract types it. A frame without one still has its slash text
  // and captions read, since the store takes a caption as the body when there is none: the guard fails toward privacy.
  const body = typeof frame.body === 'string' ? guard.redact(frame.body, MESSAGE_BODY_MAX) : null;
  const slash = frame.slashCommand && typeof frame.slashCommand.text === 'string' ? guard.redact(frame.slashCommand.text) : null;
  const media = Array.isArray(frame.media) ? frame.media : [];
  const captions = media.map((item) => (typeof item?.caption === 'string' ? guard.redact(item.caption, MESSAGE_BODY_MAX) : null));
  const kinds = redactedKinds(body, slash, ...captions);
  if (kinds.length === 0) return { frame, kinds };
  return {
    frame: {
      ...frame,
      ...(body && body.kinds.length > 0 ? { body: body.text } : {}),
      ...(frame.slashCommand && slash && slash.kinds.length > 0 ? { slashCommand: { ...frame.slashCommand, text: slash.text } } : {}),
      ...(captions.some((caption) => caption !== null && caption.kinds.length > 0)
        ? { media: media.map((item, index) => {
          const caption = captions[index];
          return caption && caption.kinds.length > 0 ? { ...item, caption: caption.text } : item;
        }) }
        : {}),
    },
    kinds,
  };
}
