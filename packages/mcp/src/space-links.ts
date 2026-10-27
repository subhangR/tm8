/**
 * Space links on the MCP surface: what a model may read, and what it is told
 * when it names a write it may not make.
 *
 * `spaceLinks.list` and `spaceLinks.audit` are reads open to every home member,
 * agents included (catalog: `kind: 'read'`, no `humanOnly`). Until they were
 * curated here a chat could not answer "which spaces does this one link to" at
 * all: `tm8_read` refused the op by name, and the space_link entity is built to
 * say nothing (projector: `spaceLinks.list answers for a link`).
 *
 * NO SECRET REACHES A TOOL RESULT. The Server never returns a stored link
 * session; a tool result is still the model's context and the chat transcript,
 * so every spaceLinks.* result is passed through `scrubSecrets` (ported from
 * cli/src/commands/link.ts — keep the two in step) and loses `mine.sessionId`,
 * an id a model has no use for.
 *
 * Every spaceLinks write is human-only in SQL and in the catalog. None is in a
 * directory; a model that names one anyway is told what its human must run,
 * as the CLI tells an agent, instead of the generic "not available".
 */
import { getOperation, isOperationName } from '@tm8/contract';

export const REDACTED = '[redacted]';

/*
 * Ported verbatim from cli/src/commands/link.ts (scrubText/scrubSecrets): a
 * token shape is judged against a whole RUN of the base64url alphabet — a tm8
 * prefix anywhere in it, a long hex stretch, or a run of 40+ that is not a
 * name — and the whole run is replaced. A UUID is none of them.
 */
const RUN = /[A-Za-z0-9_-]+/g;
const TM8_PREFIX = /tm8[a-z]{0,3}_[A-Za-z0-9_-]/;
const LONG_HEX = /[0-9a-fA-F]{32,}/;
const NAME_SHAPE = /^[a-z0-9]{1,20}(?:[-_][a-z0-9]{1,20})+$/;
const HEX_WORD = /^[0-9a-f]{8,}$|^(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{4,}$/;

function nameShaped(run: string): boolean {
  return NAME_SHAPE.test(run) && !run.split(/[-_]/).some((word) => HEX_WORD.test(word));
}

function tokenShaped(run: string): boolean {
  if (TM8_PREFIX.test(run) || LONG_HEX.test(run)) return true;
  return run.length >= 40 && !nameShaped(run);
}

export function scrubText(text: string): string {
  return text.replace(RUN, (run) => (tokenShaped(run) ? REDACTED : run));
}

export function scrubSecrets<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubSecrets(v)])) as T;
  }
  return value;
}

/** True for every spaceLinks.* operation, read or write. */
export function isSpaceLinkOperation(operation: string): boolean {
  return operation.startsWith('spaceLinks.');
}

/**
 * A spaceLinks.* result as a model may see it: `mine.sessionId` dropped from
 * every link view, then every string scrubbed. Status, expiry, alias and the
 * spawn switch stay — they are what "is this link usable" is answered from.
 */
export function linkSafe(data: unknown): unknown {
  const withoutSession = (view: unknown): unknown => {
    if (view === null || typeof view !== 'object' || Array.isArray(view)) return view;
    const mine = (view as { mine?: unknown }).mine;
    if (mine === null || typeof mine !== 'object' || Array.isArray(mine)) return view;
    const { sessionId: _sessionId, ...rest } = mine as Record<string, unknown>;
    return { ...view, mine: rest };
  };
  return scrubSecrets(Array.isArray(data) ? data.map(withoutSession) : withoutSession(data));
}

/**
 * What the human runs for each human-only link write. Only `add`, `login` and
 * the target-side three have a CLI command; the rest are the human's to do
 * from their own session.
 */
const HUMAN_COMMANDS: Readonly<Record<string, string>> = {
  'spaceLinks.add': 'tm8 link add <target-space-id>',
  'spaceLinks.login': 'tm8 link login <alias|link-id>',
  'spaceLinks.inbound.revoke': 'tm8 link revoke <link-id>',
  'spaceLinks.inbound.restore': 'tm8 link restore <link-id>',
  'spaceLinks.inbound.grant': 'tm8 link grant <home-space-id>',
};

/**
 * The refusal for a human-only spaceLinks write, or undefined for anything
 * else. Decided by the catalog's own `humanOnly` flag, not a local list.
 */
export function humanOnlyLinkRefusal(operation: string): string | undefined {
  if (!isSpaceLinkOperation(operation) || !isOperationName(operation)) return undefined;
  if (getOperation(operation).humanOnly !== true) return undefined;
  const command = HUMAN_COMMANDS[operation];
  return command
    ? `${operation} is human-only: ask your human to run \`${command}\``
    : `${operation} is human-only: ask your human to do it from their own tm8 session`;
}
