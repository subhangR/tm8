/**
 * The Slack provider's pure rules (Slack bridge design §1.1–1.3, §4).
 *
 * Held here, each with a screen that goes wrong without it:
 * - the dialog's token checks ARE the contract's, proven by running both over
 *   the same strings: a contract change cannot leave the form laxer
 * - a swapped pair and a user token are named, not just "invalid"
 * - the scope warning is the manifest minus what Slack granted
 * - every `logged_out` code the brief lists maps to words that say what to do
 * - the deep links are Slack's own permalink shapes, thread replies included
 * - thread mode's three choices carry §1.2's explanations
 */
import { describe, expect, it } from 'vitest';
import { BridgeConnectionBeginInputSchema, SLACK_CAPABILITIES, WHATSAPP_CAPABILITIES } from '@tm8/contract';
import type { SlackAccount } from '@tm8/contract';
import {
  DEFAULT_SLACK_THREAD_MODE, SLACK_APP_TOKEN_RE, SLACK_BOT_TOKEN_RE, SLACK_MANIFEST_BOT_SCOPES,
  THREAD_MODE_OPTIONS, capabilitiesOf, connectsByTokens, conversationLabel, hasNativeThreads, isPrivateChannel,
  isSlackTs, missingScopeLines, missingSlackScopes, slackAccountLine, slackChannelLabel, slackChannelUrl,
  slackExternalAccountId, slackHost, slackMessageUrl, slackPickerEmptyHint, slackRefusalWords, slackTokenProblem,
  slackWorkspaceUrl,
} from './slack';

/*
 * The tokens in this file are deliberately unrealistic — short, with zero
 * digit groups and a NOTAREAL… body. They still satisfy the contract's
 * regexes, which is all the code under test reads, and they do not look
 * enough like real Slack tokens to trip GitHub's secret scanning (which
 * blocked a push of this branch when they did).
 */
const BOT = 'xoxb-0-0-NOTAREALBOTTOKEN';
const APP = 'xapp-0-A0-0-NOTAREALAPPTOKEN';

const account = (over: Partial<SlackAccount> = {}): SlackAccount => ({
  teamId: 'T024ACME', teamName: 'Acme', url: 'https://acme.slack.com/',
  enterpriseId: null, enterpriseName: null, isEnterpriseInstall: false,
  botUserId: 'U07TM8BOT', botId: 'B07TM8BOT', botName: 'tm8',
  scopes: [...SLACK_MANIFEST_BOT_SCOPES],
  ...over,
});

describe('the token checks are the contract’s', () => {
  /* What the server would do with this pair: the credential arm of
     bridges.connections.begin, which is what the dialog submits. */
  const serverTakes = (botToken: string, appToken: string) =>
    BridgeConnectionBeginInputSchema.safeParse({
      clientMutationId: 'm-1', provider: 'slack',
      credential: { kind: 'slack_tokens', botToken, appToken },
    }).success;

  const pairs: [string, string][] = [
    [BOT, APP],
    ['xoxb-1-2-abc', 'xapp-1-A-2-abc'],
    ['', ''],
    ['xoxb-short', APP],
    [BOT, 'xapp-nope'],
    ['xoxp-0-0-NOTAREALUSERTOKEN', APP],
    [APP, BOT],
    [`  ${BOT}  `, `  ${APP}  `],
  ];

  it.each(pairs)('agrees with the server about (%s, %s)', (bot, app) => {
    const uiTakes = slackTokenProblem(bot, app) === null;
    expect(uiTakes).toBe(serverTakes(bot.trim(), app.trim()));
  });

  it('accepts a good pair, and trims before judging', () => {
    expect(slackTokenProblem(BOT, APP)).toBeNull();
    expect(slackTokenProblem(` ${BOT}\n`, `\t${APP} `)).toBeNull();
  });

  it('names the mistakes people actually make', () => {
    expect(slackTokenProblem('', '')).toMatch(/both tokens/i);
    // The pair the other way round: both halves are valid tokens, so a
    // prefix check alone would pass them straight to the server.
    expect(slackTokenProblem(APP, BOT)).toMatch(/other way round/i);
    expect(slackTokenProblem('xoxp-0-0-NOTAREALUSERTOKEN', APP)).toMatch(/user token/i);
    expect(slackTokenProblem('xoxb-truncated', APP)).toMatch(/cut off/i);
    expect(slackTokenProblem(BOT, 'xapp-truncated')).toMatch(/cut off/i);
    expect(slackTokenProblem('hunter2', 'hunter2')).toMatch(/starts with xoxb-/i);
  });

  it('never echoes what was pasted', () => {
    const secret = 'xoxb-DEADBEEFSECRETVALUE';
    expect(slackTokenProblem(secret, 'xapp-nope')).not.toContain('DEADBEEF');
  });

  it('exports the contract’s own regexes, not a copy', () => {
    expect(SLACK_BOT_TOKEN_RE.test(BOT)).toBe(true);
    expect(SLACK_APP_TOKEN_RE.test(APP)).toBe(true);
    expect(SLACK_BOT_TOKEN_RE.test(APP)).toBe(false);
  });
});

describe('scopes (§4)', () => {
  it('warns about nothing when the install granted the manifest', () => {
    expect(missingSlackScopes(account())).toEqual([]);
    expect(missingScopeLines(account())).toEqual([]);
  });
  it('lists what is missing, in manifest order, with what stops working', () => {
    const thin = account({ scopes: ['channels:history', 'channels:read', 'chat:write'] });
    const missing = missingSlackScopes(thin);
    expect(missing).toContain('chat:write.customize');
    expect(missing).toContain('users:read.email');
    expect(missing).not.toContain('chat:write');
    // manifest order, so the list reads the same as the manifest does
    expect(missing).toEqual(SLACK_MANIFEST_BOT_SCOPES.filter((s) => !thin.scopes.includes(s)));
    expect(missingScopeLines(thin)).toContain('chat:write.customize — replies will all come from one name and icon instead of each session\'s own');
  });
  it('says nothing at all when there is no account yet', () => {
    expect(missingSlackScopes(null)).toEqual([]);
    expect(missingSlackScopes(undefined)).toEqual([]);
  });
  it('asks for the optional DM scopes nowhere (they are off by default)', () => {
    expect(SLACK_MANIFEST_BOT_SCOPES).not.toContain('im:history');
  });
});

describe('the connected line', () => {
  it('names the workspace, its host and the bot', () => {
    expect(slackAccountLine(account())).toBe('Connected to Acme (acme.slack.com) as @tm8');
  });
  it('names the org too on an Enterprise Grid org-wide install', () => {
    const grid = account({
      url: 'https://acme.enterprise.slack.com/', enterpriseId: 'E024ACME', enterpriseName: 'Acme Corp',
      isEnterpriseInstall: true,
    });
    expect(slackAccountLine(grid)).toBe('Connected to Acme · Acme Corp (acme.enterprise.slack.com) as @tm8');
  });
  it('does not repeat the name when the org and the workspace are called the same', () => {
    const same = account({ enterpriseName: 'Acme', enterpriseId: 'E1', isEnterpriseInstall: true });
    expect(slackAccountLine(same)).toBe('Connected to Acme (acme.slack.com) as @tm8');
  });
  it('is the org id that identifies a Grid install, the team id otherwise', () => {
    expect(slackExternalAccountId(account())).toBe('T024ACME');
    expect(slackExternalAccountId(account({ isEnterpriseInstall: true, enterpriseId: 'E024ACME' }))).toBe('E024ACME');
  });
  it('shows a host even when the runtime answered something that is not a URL', () => {
    expect(slackHost('acme.slack.com')).toBe('acme.slack.com');
  });
});

describe('why Slack refused the tokens', () => {
  /* Every code the brief lists, plus the shapes Slack really sends. */
  it.each([
    ['invalid_auth', /revoked, rotated or copied/i],
    ['not_authed', /no token reached slack/i],
    ['not_allowed_token_type', /wrong KIND of token/],
    ['missing_scope: chat:write', /missing the chat:write scope/i],
    ['missing_scope', /missing a scope/i],
    ['account_inactive', /uninstalled or disabled/i],
    ['no_credential', /holds no tokens/i],
    ['invalid_app_token', /app-level token/i],
    // the codes lane C's runtime adds (#1507)
    ['app_token: invalid_auth', /refused the app-level token/i],
    ['token_revoked', /revoked in Slack/i],
    ['token_expired', /have expired/i],
    ['app_uninstalled', /uninstalled from the workspace/i],
    ['app_already_connected', /already connected through another tm8 connection/i],
    ['removed', /was removed/i],
  ])('%s says what to do', (detail, words) => {
    expect(slackRefusalWords(detail)).toMatch(words);
  });

  it('still says something useful with no detail at all', () => {
    expect(slackRefusalWords(null)).toMatch(/gave no reason/i);
    expect(slackRefusalWords('')).toMatch(/gave no reason/i);
    expect(slackRefusalWords(undefined)).toMatch(/gave no reason/i);
  });

  it('shows an unknown code rather than swallowing it', () => {
    expect(slackRefusalWords('ratelimited')).toContain('ratelimited');
  });

  it('carries the inner code through on app_token, and names the xapp half', () => {
    const words = slackRefusalWords('app_token: invalid_auth');
    expect(words).toContain('invalid_auth');
    expect(words).toMatch(/xapp-/);
    expect(words).toMatch(/bot token is fine/);
  });

  it('keeps a scope name whole, colons and all', () => {
    expect(slackRefusalWords('missing_scope: users:read.email')).toContain('users:read.email');
    expect(slackRefusalWords('missing_scope: chat:write.customize')).toContain('chat:write.customize');
  });

  it('says something for every code the runtime can send, and never crashes on 500 chars', () => {
    const codes = [
      'invalid_auth', 'not_authed', 'not_allowed_token_type', 'missing_scope: x', 'account_inactive',
      'token_revoked', 'token_expired', 'app_uninstalled', 'app_token: ratelimited', 'no_credential', 'removed',
      'app_already_connected',
    ];
    for (const code of codes) expect(slackRefusalWords(code).length).toBeGreaterThan(30);
    expect(() => slackRefusalWords('x'.repeat(500))).not.toThrow();
  });

  it('every answer ends in something the reader can act on', () => {
    for (const code of ['invalid_auth', 'not_authed', 'not_allowed_token_type', 'missing_scope', 'account_inactive', 'no_credential']) {
      expect(slackRefusalWords(code).length).toBeGreaterThan(40);
    }
  });
});

describe('View in Slack', () => {
  const URL_WITH = 'https://acme.slack.com/';
  const URL_WITHOUT = 'https://acme.slack.com';

  it('links a channel', () => {
    expect(slackChannelUrl(URL_WITH, 'C04DEPLOYS')).toBe('https://acme.slack.com/archives/C04DEPLOYS');
  });
  it('joins cleanly whether or not the workspace URL ends in a slash', () => {
    expect(slackChannelUrl(URL_WITHOUT, 'C1')).toBe(slackChannelUrl(URL_WITH, 'C1'));
    expect(slackChannelUrl(URL_WITH, 'C1')).not.toContain('//archives');
  });
  it('links a message by its ts, with the dot taken out', () => {
    expect(slackMessageUrl(URL_WITH, 'C04DEPLOYS', '1763462400.123456'))
      .toBe('https://acme.slack.com/archives/C04DEPLOYS/p1763462400123456');
  });
  it('opens a reply in its thread, not just the channel', () => {
    expect(slackMessageUrl(URL_WITH, 'C04DEPLOYS', '1763462500.000200', '1763462400.123456'))
      .toBe('https://acme.slack.com/archives/C04DEPLOYS/p1763462500000200?thread_ts=1763462400.123456&cid=C04DEPLOYS');
  });
  it('leaves the thread query off a top-level message', () => {
    expect(slackMessageUrl(URL_WITH, 'C1', '1.2', null)).not.toContain('thread_ts');
  });

  /*
   * #1509 review 3: not every externalMessageId is a ts. Lane C logs a /tm8
   * command as `cmd:<trigger_id>` (#1507), which names no message, so it must
   * never become a permalink.
   */
  it('only a <seconds>.<microseconds> value is a linkable ts', () => {
    expect(isSlackTs('1763462400.123456')).toBe(true);
    expect(isSlackTs('1.2')).toBe(true);
    expect(isSlackTs('cmd:12345abc')).toBe(false);
    expect(isSlackTs('cmd:999')).toBe(false);
    expect(isSlackTs('1763462400')).toBe(false);
    expect(isSlackTs('')).toBe(false);
    expect(isSlackTs(null)).toBe(false);
    expect(isSlackTs(undefined)).toBe(false);
  });

  it('drops a thread root that is a command id, instead of encoding it', () => {
    const url = slackMessageUrl(URL_WITH, 'C1', '1763462500.000200', 'cmd:999');
    expect(url).toBe('https://acme.slack.com/archives/C1/p1763462500000200');
    expect(url).not.toContain('thread_ts');
    expect(url).not.toContain('cmd');
  });
  it('has no workspace URL for a non-Slack connection, or a Slack one that has not reported', () => {
    expect(slackWorkspaceUrl(null)).toBeNull();
    expect(slackWorkspaceUrl({ provider: 'whatsapp', account: null })).toBeNull();
    expect(slackWorkspaceUrl({ provider: 'slack', account: null })).toBeNull();
    expect(slackWorkspaceUrl({ provider: 'slack', account: account() })).toBe('https://acme.slack.com/');
  });
});

describe('thread mode (§1.2)', () => {
  it('defaults to mention', () => {
    expect(DEFAULT_SLACK_THREAD_MODE).toBe('mention');
    expect(THREAD_MODE_OPTIONS[0]![0]).toBe('mention');
    expect(THREAD_MODE_OPTIONS[0]![1]).toMatch(/default/i);
  });
  it('offers exactly the three modes, each with a one-line explanation', () => {
    expect(THREAD_MODE_OPTIONS.map(([m]) => m)).toEqual(['mention', 'every', 'off']);
    for (const [, label, words] of THREAD_MODE_OPTIONS) {
      expect(label.length).toBeGreaterThan(2);
      expect(words.length).toBeGreaterThan(30);
    }
  });
  it('warns, on *every message*, where it is safe to use', () => {
    expect(THREAD_MODE_OPTIONS.find(([m]) => m === 'every')![2]).toMatch(/low-traffic/i);
  });
});

describe('channels and capabilities', () => {
  it('labels a channel with one hash, however the runtime named it', () => {
    expect(slackChannelLabel('eng-support')).toBe('#eng-support');
    expect(slackChannelLabel('#eng-support')).toBe('#eng-support');
    expect(conversationLabel({ kind: 'channel', name: 'deploys' })).toBe('#deploys');
    expect(conversationLabel({ kind: 'private_channel', name: 'incidents' })).toBe('#incidents');
  });
  it('leaves a WhatsApp group’s name alone', () => {
    expect(conversationLabel({ kind: 'group', name: 'Infra' })).toBe('Infra');
    expect(conversationLabel({ kind: 'self', name: 'Ada (you)' })).toBe('Ada (you)');
  });
  it('locks a private channel only', () => {
    expect(isPrivateChannel({ kind: 'private_channel' })).toBe(true);
    expect(isPrivateChannel({ kind: 'channel' })).toBe(false);
    expect(isPrivateChannel({ kind: 'group' })).toBe(false);
  });
  it('answers each provider’s capability sheet', () => {
    expect(capabilitiesOf('slack')).toBe(SLACK_CAPABILITIES);
    expect(capabilitiesOf('whatsapp')).toBe(WHATSAPP_CAPABILITIES);
    // An unbuilt provider gets the sheet those rows drew before this existed.
    expect(capabilitiesOf('telegram')).toBe(WHATSAPP_CAPABILITIES);
  });
  it('knows which affordances belong to which provider', () => {
    expect(connectsByTokens('slack')).toBe(true);
    expect(connectsByTokens('whatsapp')).toBe(false);
    expect(hasNativeThreads('slack')).toBe(true);
    expect(hasNativeThreads('whatsapp')).toBe(false);
    // The WhatsApp-only affordances the Slack screens must hide.
    expect(capabilitiesOf('slack').polls).toBe(false);
    expect(capabilitiesOf('slack').typing).toBe(false);
    expect(capabilitiesOf('slack').readReceipts).toBe(false);
    expect(capabilitiesOf('slack').perUserVoice).toBe(true);
  });
  it('tells an admin how to make a channel appear', () => {
    expect(slackPickerEmptyHint('tm8')).toContain('/invite @tm8');
    expect(slackPickerEmptyHint(null)).toContain('/invite @tm8');
    expect(slackPickerEmptyHint('acme-bot')).toContain('/invite @acme-bot');
  });
});
