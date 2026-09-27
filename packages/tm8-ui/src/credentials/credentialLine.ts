import type {
  SessionCredentialCard,
  SessionCredentialProviderView,
  SessionCredentialView,
} from '@tm8/contract';

/**
 * THE CREDENTIAL LINE — spec doc 01a0e248 §6, `session-names-its-credential`.
 *
 * Every session says what it runs on, by card identity and never by secret, and
 * this is the ONLY function that builds that sentence. It formats the
 * `credential` block the server returns on the session's own `entities.get`,
 * which is already masked for the viewer. Nothing here decides what the viewer
 * may see: a login or key hint the server withheld is absent, and
 * `detailHidden` says so. `credential-line-ban.test.ts` fails on any other
 * builder of this line.
 *
 * The line describes the BINDING, not current usability. A card revoked since
 * launch is still named, as "Ran on … (revoked)".
 *
 * `legacy` names the present and the future (§4 rule 4): the rung it runs on
 * now, and that release 2 removes it. That is the one place the words
 * "member" and "node" appear, as the rung names. Ownership copy never uses
 * them; another person's card is "someone else's", as in the credential panel.
 */

const PROVIDER_NAME: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
};

const NONE_REASON: Readonly<Record<string, string>> = {
  shell: 'shell session',
  credential_login: 'credential login terminal',
  container_exec: 'container exec session',
  'echo-agent': 'echo agent',
};

const providerName = (provider: string): string =>
  PROVIDER_NAME[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);

function ownership(card: SessionCredentialCard): string {
  const who = card.ownerName ?? 'someone else';
  switch (card.owner) {
    case 'space':
      return 'space credential';
    case 'you':
      return card.visibility === 'private' ? 'private, yours' : 'yours';
    case 'other':
      return card.visibility === 'private' ? `private, owned by ${who}` : `owned by ${who}`;
  }
}

/** A removed rung, in the words §4 rule 4 pins. */
function rungPhrase(rung: 'member' | 'node', launchedByViewer: boolean, what: 'credential' | 'login'): string {
  if (rung === 'node') return `the node's login (node rung)`;
  return `${launchedByViewer ? 'your own' : "the launcher's own"} ${what} (member rung)`;
}

interface Segment {
  text: string;
  /** Model-provider segments open the line with "Running on" / "Ran on". */
  model: boolean;
  revoked: boolean;
}

function modelSegment(p: SessionCredentialProviderView, launchedByViewer: boolean): Segment {
  const name = providerName(p.provider);
  if (p.rung !== 'space') {
    return { text: `${rungPhrase(p.rung, launchedByViewer, 'credential')} · ${name}`, model: true, revoked: false };
  }
  const card = p.credential;
  if (!card) return { text: `a credential not visible to you · ${name}`, model: true, revoked: false };
  if (card.status === 'revoked') return { text: `"${card.label}" (revoked) · ${name}`, model: true, revoked: true };
  return { text: `"${card.label}" · ${name} · ${ownership(card)}`, model: true, revoked: false };
}

function gitSegment(p: SessionCredentialProviderView, launchedByViewer: boolean): Segment {
  if (p.rung !== 'space') {
    return { text: `git on ${rungPhrase(p.rung, launchedByViewer, 'login')}`, model: false, revoked: false };
  }
  const card = p.credential;
  if (!card || card.detailHidden) return { text: 'git as (hidden)', model: false, revoked: card?.status === 'revoked' };
  const who = card.displayLogin ?? `"${card.label}"`;
  const revoked = card.status === 'revoked';
  return { text: `git as ${who}${revoked ? ' (revoked)' : ''}`, model: false, revoked };
}

function runningLine(view: SessionCredentialView): string {
  const segments = view.providers.map((p) =>
    p.provider === 'github' ? gitSegment(p, view.launchedByViewer) : modelSegment(p, view.launchedByViewer),
  );
  const [first] = segments;
  let line: string;
  if (!first) {
    line = view.binding === 'legacy'
      ? 'No named credential; a personal or node login is still reachable'
      : 'Credential recorded, but not visible to you';
  } else if (first.model) {
    line = `${first.revoked ? 'Ran on' : 'Running on'} ${[first, ...segments.slice(1)].map((s) => s.text).join(' · ')}`;
  } else {
    line = `No model credential · ${segments.map((s) => s.text).join(' · ')}`;
  }
  const rungs = new Set(view.providers.map((p) => p.rung).filter((r) => r !== 'space'));
  if (rungs.size === 1) line += ' — this rung goes away at release 2';
  else if (rungs.size > 1 || (view.binding === 'legacy' && !first)) line += ' — these rungs go away at release 2';
  return line;
}

/**
 * The session's credential line, or null when the read carried no block (a
 * list read, or a server older than R1/S2). Null renders nothing; it never
 * reads as "no credential".
 */
export function credentialLine(view: SessionCredentialView | null | undefined): string | null {
  if (!view) return null;
  let line: string;
  switch (view.binding) {
    case 'none': {
      const reason = view.noneReason ?? '';
      line = `No vendor credential — ${NONE_REASON[reason] ?? (reason.replace(/_/g, ' ') || 'none needed')}`;
      break;
    }
    case 'unrecorded':
      line = 'Credential not recorded — this session started before sessions recorded theirs';
      break;
    case 'pending':
      line = 'Credential not recorded yet — the session is still resolving it';
      break;
    case 'bound':
    case 'legacy':
      line = runningLine(view);
      break;
  }
  return view.resumedBy ? `${line} · resumed by ${view.resumedBy}` : line;
}
