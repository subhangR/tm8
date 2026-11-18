import type {
  BridgeConnectionView, BridgeProvider, BridgeThreadMode, ConversationItem, RuntimeCapabilities, SlackAccount,
} from '@tm8/contract';
import { SLACK_APP_TOKEN_RE, SLACK_BOT_TOKEN_RE, SLACK_CAPABILITIES, WHATSAPP_CAPABILITIES } from '@tm8/contract';

/*
 * THE SLACK PROVIDER'S WORDS AND LINKS (Slack bridge design §1.1–1.3, §4;
 * protocol v4).
 *
 * Everything here is PURE: the token checks, the scope warning, the words for
 * a refused token, the "View in Slack" URLs and the thread-mode copy. The
 * screens (SlackTokensDialog, AddBridgeWizard, RoutingTab, BridgePage) draw
 * these answers and hold no Slack knowledge of their own, so a rule can be
 * held in a test without a DOM — and so the connection dialog never has a
 * second, drifting idea of what a valid token looks like.
 *
 * NO TOKEN EVER REACHES THIS MODULE'S OUTPUT. The checks answer booleans and
 * sentences; none of them echoes what was pasted.
 */

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/*
 * The client-side format checks ARE the contract's (`bridges.ts`, used by
 * `BridgeConnectionBeginInputSchema.credential`), re-exported rather than
 * copied: the dialog refuses locally exactly what the server would refuse, so
 * a paste never travels to be rejected, and a contract change cannot leave a
 * second, laxer idea of a valid token behind in this lane.
 *
 * They are structural, not just prefixes — `xoxb-<digits>-<digits>-<alnum>`
 * and `xapp-<digit>-<id>-<digits>-<alnum>` — which is what catches a token
 * that was truncated by a copy out of a terminal.
 */
export { SLACK_APP_TOKEN_RE, SLACK_BOT_TOKEN_RE } from '@tm8/contract';

/** Where each token lives in the Slack app config (§1.1 step 3) — the help text under each input. */
export const SLACK_TOKEN_HELP = {
  bot: 'In your Slack app at api.slack.com/apps → OAuth & Permissions → Bot User OAuth Token. It starts with xoxb-.',
  app: 'Basic Information → App-Level Tokens → Generate Token and Scopes, with the connections:write scope. It starts with xapp-.',
} as const;

/** The setup guide lane E writes; shown as a path and linked on the repo's default branch. */
export const SLACK_SETUP_GUIDE_PATH = 'integrations/slack-bridge/SETUP.md';
export const SLACK_SETUP_GUIDE_URL = `https://github.com/subhangR/tm8/blob/main/${SLACK_SETUP_GUIDE_PATH}`;

/**
 * Why a pasted pair cannot be sent yet, or null. One sentence, naming the
 * field — never the value. A swapped pair is the mistake people actually make
 * (both tokens look alike at a glance), so it is named on its own.
 */
export function slackTokenProblem(botToken: string, appToken: string): string | null {
  const bot = botToken.trim();
  const app = appToken.trim();
  if (bot === '' || app === '') return 'Paste both tokens: the bot token and the app-level token.';
  if (SLACK_BOT_TOKEN_RE.test(app) && SLACK_APP_TOKEN_RE.test(bot)) {
    return 'These two are the other way round: the xoxb- token is the bot token and the xapp- one is the app-level token.';
  }
  if (!SLACK_BOT_TOKEN_RE.test(bot)) {
    if (bot.startsWith('xoxp-')) {
      return 'That is a user token (xoxp-). The bridge needs the BOT token, under OAuth & Permissions → Bot User OAuth Token.';
    }
    return bot.startsWith('xoxb-')
      ? 'That does not look like a whole bot token. It reads xoxb-<digits>-<digits>-<letters and digits>; check nothing was cut off when you copied it.'
      : 'The bot token starts with xoxb-, under OAuth & Permissions → Bot User OAuth Token.';
  }
  if (!SLACK_APP_TOKEN_RE.test(app)) {
    return app.startsWith('xapp-')
      ? 'That does not look like a whole app-level token. It reads xapp-<digit>-<id>-<digits>-<letters and digits>; check nothing was cut off when you copied it.'
      : 'The app-level token starts with xapp-. Generate it under Basic Information → App-Level Tokens with the connections:write scope.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scopes (design §4)
// ---------------------------------------------------------------------------

/** The bot scopes the shipped manifest asks for. A granted set missing any of these is warned about. */
export const SLACK_MANIFEST_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'chat:write',
  'chat:write.customize',
  'reactions:read',
  'reactions:write',
  'files:read',
  'files:write',
  'users:read',
  'users:read.email',
  'commands',
] as const;

/**
 * What each manifest scope buys, so the warning says what stops working
 * rather than only naming a string. §4, and the features in §1.3 and §2.
 */
const SCOPE_COST: Record<string, string> = {
  'app_mentions:read': 'tm8 will not see @mentions of itself',
  'channels:history': 'messages in public channels will not arrive',
  'channels:read': 'public channels will not appear in the picker',
  'groups:history': 'messages in private channels will not arrive',
  'groups:read': 'private channels will not appear in the picker',
  'chat:write': 'tm8 cannot post anything back',
  'chat:write.customize': 'replies will all come from one name and icon instead of each session\'s own',
  'reactions:read': 'reactions in Slack will not reach tm8',
  'reactions:write': 'the 📨 👀 ✅ progress reactions will not appear',
  'files:read': 'files posted in Slack will not reach the session',
  'files:write': 'files a session makes cannot be uploaded back',
  'users:read': 'senders will show as raw Slack ids',
  'users:read.email': 'Slack users will not be auto-linked to tm8 members by email',
  commands: 'the /tm8 slash commands will not work',
};

/** The manifest scopes Slack did NOT grant, in manifest order. Empty when the install is complete. */
export function missingSlackScopes(account: Pick<SlackAccount, 'scopes'> | null | undefined): string[] {
  if (!account) return [];
  const granted = new Set(account.scopes);
  return SLACK_MANIFEST_BOT_SCOPES.filter((scope) => !granted.has(scope));
}

/** One line per missing scope: `chat:write — tm8 cannot post anything back`. */
export function missingScopeLines(account: Pick<SlackAccount, 'scopes'> | null | undefined): string[] {
  return missingSlackScopes(account).map((s) => (SCOPE_COST[s] ? `${s} — ${SCOPE_COST[s]}` : s));
}

// ---------------------------------------------------------------------------
// The account line, and why a token was refused
// ---------------------------------------------------------------------------

/** The host of the workspace URL, for the connected line: `acme.enterprise.slack.com`. */
export function slackHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // A runtime that answered something that is not a URL: show it as it came, never crash the row.
    return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

/**
 * *Connected to Acme (acme.slack.com) as @tm8* (§1.1 step 4). An org-wide
 * Enterprise Grid install (`isEnterpriseInstall`) names the org too, since
 * one install then covers every workspace the org admin approved.
 */
export function slackAccountLine(account: SlackAccount): string {
  const org = account.isEnterpriseInstall && account.enterpriseName && account.enterpriseName !== account.teamName
    ? ` · ${account.enterpriseName}`
    : '';
  return `Connected to ${account.teamName}${org} (${slackHost(account.url)}) as @${account.botName}`;
}

/** What `externalAccountId` holds for a Slack connection: the org on a Grid install, else the team. */
export function slackExternalAccountId(account: SlackAccount): string {
  return account.isEnterpriseInstall ? account.enterpriseId ?? account.teamId : account.teamId;
}

/**
 * Slack's own error code behind `logged_out`, in words an admin can act on.
 * The code arrives as the runtime's `state.detail` (protocol v4); a
 * `missing_scope: <scope>` detail carries the scope, so it is parsed off.
 * An unknown code is shown as itself rather than swallowed — never a token,
 * since the runtime never puts one in `detail`.
 */
export function slackRefusalWords(detail: string | null | undefined): string {
  const code = (detail ?? '').trim();
  /* Split on the FIRST colon only: a scope name has colons of its own
     (`chat:write`, `users:read.email`), so splitting on every one and
     rejoining renamed the scope in the warning. */
  const cut = code.indexOf(':');
  const head = cut === -1 ? code : code.slice(0, cut);
  const scope = cut === -1 ? '' : code.slice(cut + 1).trim();
  switch (head) {
    case 'invalid_auth':
      return 'Slack refused the tokens. They may have been revoked, rotated or copied from another app — generate them again and paste both.';
    case 'not_authed':
      return 'No token reached Slack. Paste both tokens again.';
    case 'not_allowed_token_type':
      return 'One of these is the wrong KIND of token. The bot token (xoxb-) goes in the first box and the app-level token (xapp-) in the second; a user token (xoxp-) does not work.';
    case 'missing_scope':
      return scope
        ? `The Slack app is missing the ${scope} scope. Add it in the app's OAuth & Permissions, reinstall the app to the workspace, then paste the new bot token.`
        : 'The Slack app is missing a scope the bridge needs. Re-create it from tm8\'s manifest, reinstall it, then paste the new tokens.';
    case 'account_inactive':
      return 'This Slack app has been uninstalled or disabled in the workspace. Install it again (an Enterprise Grid org admin may have to approve it), then paste the new tokens.';
    case 'no_credential':
      return 'tm8 holds no tokens for this connection yet. Paste the bot token and the app-level token.';
    case 'invalid_app_token':
      return 'The app-level token (xapp-) was refused. Generate a new one under Basic Information → App-Level Tokens with the connections:write scope.';
    /* The runtime reports a refusal of the xapp- half as `app_token: <code>`
       (lane C, #1507), so the Socket Mode side is named rather than leaving an
       admin re-copying a bot token that was never the problem. */
    case 'app_token':
      return `Slack refused the app-level token (xapp-)${scope ? `: ${scope}` : ''}. Generate a new one under Basic Information → App-Level Tokens with the connections:write scope; the bot token is fine.`;
    case 'token_revoked':
      return 'These tokens were revoked in Slack. Generate a new pair in the app\'s settings and paste both.';
    case 'token_expired':
      return 'These tokens have expired. Generate a new pair in the app\'s settings and paste both.';
    case 'app_uninstalled':
      return 'The Slack app has been uninstalled from the workspace. Install it again (an Enterprise Grid org admin may have to approve it), then paste the new tokens.';
    /* Two connections on one Slack app: Slack would split the socket's events
       between them, so neither sees everything (lane C, #1507). */
    case 'app_already_connected':
      return 'This Slack app is already connected through another tm8 connection on this node, and Slack would split its events between the two. Disconnect the other connection, or make a separate Slack app for this one.';
    case 'removed':
      return 'This connection was removed, so its tokens were deleted. Add the workspace again to reconnect it.';
    case '':
      return 'Slack refused the tokens and gave no reason. Paste them again; if it keeps failing, check the app is still installed in the workspace.';
    default:
      return `Slack refused the tokens: ${code}. Check the app at api.slack.com/apps is installed in this workspace, then paste both tokens again.`;
  }
}

// ---------------------------------------------------------------------------
// View in Slack (deep links)
// ---------------------------------------------------------------------------

/** `https://acme.slack.com/` — exactly one trailing slash, so `archives/…` joins cleanly. */
function base(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/** The channel in Slack: `<workspace>/archives/<channelId>`. */
export function slackChannelUrl(workspaceUrl: string, channelId: string): string {
  return `${base(workspaceUrl)}archives/${channelId}`;
}

/**
 * One message in Slack: `…/archives/<channelId>/p<ts without the dot>`, and
 * for a reply inside a thread `?thread_ts=<root>&cid=<channelId>` — which is
 * what makes Slack open the thread rather than the channel at that moment.
 */
export function slackMessageUrl(
  workspaceUrl: string,
  channelId: string,
  ts: string,
  threadRootTs?: string | null,
): string {
  const at = `${slackChannelUrl(workspaceUrl, channelId)}/p${ts.replace('.', '')}`;
  return threadRootTs ? `${at}?thread_ts=${encodeURIComponent(threadRootTs)}&cid=${encodeURIComponent(channelId)}` : at;
}

/**
 * The workspace URL for a bridge's provider links, or null when there is
 * none to build them from: a non-Slack bridge, or a Slack connection whose
 * `auth.test` answer the surface has not read (it rides the CONNECTION, not
 * the bridge, so a surface without the connection list shows no link rather
 * than guessing a host).
 */
export function slackWorkspaceUrl(connection: Pick<BridgeConnectionView, 'provider' | 'account'> | null | undefined): string | null {
  if (!connection || connection.provider !== 'slack') return null;
  return connection.account?.url ?? null;
}

// ---------------------------------------------------------------------------
// Thread mode (§1.2)
// ---------------------------------------------------------------------------

/** The label and the one line under it, for the wizard and the Routing tab. */
export const THREAD_MODE_OPTIONS: readonly (readonly [BridgeThreadMode, string, string])[] = [
  [
    'mention',
    'Mention (default)',
    'Every top-level message that @mentions tm8 starts its own session, living in that Slack thread.',
  ],
  [
    'every',
    'Every message',
    'Every top-level message starts a session. Only for a low-traffic intake channel.',
  ],
  [
    'off',
    'Off',
    'No per-thread sessions: the channel behaves like any other bridge — @tm8 is answered by the target, and /tm8 work starts workers.',
  ],
];

/** The settled default for a new Slack bridge. */
export const DEFAULT_SLACK_THREAD_MODE: BridgeThreadMode = 'mention';

export const THREAD_MODE_WORD: Record<BridgeThreadMode, string> = {
  off: 'off', mention: 'on @mention', every: 'on every message',
};

// ---------------------------------------------------------------------------
// Conversations and capabilities
// ---------------------------------------------------------------------------

/** `#eng-support` — Slack names come without the hash; a name that has one is not given a second. */
export function slackChannelLabel(name: string): string {
  return name.startsWith('#') ? name : `#${name}`;
}

/** How the picker labels one row, by what the runtime called it. */
export function conversationLabel(item: Pick<ConversationItem, 'kind' | 'name'>): string {
  return item.kind === 'channel' || item.kind === 'private_channel' ? slackChannelLabel(item.name) : item.name;
}

/** A private channel gets a lock; nothing else does. */
export function isPrivateChannel(item: Pick<ConversationItem, 'kind'>): boolean {
  return item.kind === 'private_channel';
}

/**
 * The provider's capability sheet, so a screen hides what a provider cannot
 * do instead of each surface keeping its own list of "WhatsApp-only" bits
 * (QR and pairing, polls, group create, typing, read receipts).
 *
 * Only two runtimes exist (protocol v4). Anything else is drawn with the
 * WhatsApp sheet, which is what those rows did before this function; a third
 * provider brings its own sheet with it.
 */
export function capabilitiesOf(provider: BridgeProvider | string): RuntimeCapabilities {
  return provider === 'slack' ? SLACK_CAPABILITIES : WHATSAPP_CAPABILITIES;
}

/** Does this provider connect by pasted tokens (Slack) rather than a QR/pairing device link (WhatsApp)? */
export function connectsByTokens(provider: BridgeProvider | string): boolean {
  return provider === 'slack';
}

/** Native threads: the thread-mode setting is offered only where the runtime has them. */
export function hasNativeThreads(provider: BridgeProvider | string): boolean {
  return capabilitiesOf(provider).threads === 'native';
}

/** The picker's empty state (§1.2 step 1): the bot only sees channels it was invited to. */
export function slackPickerEmptyHint(botName: string | null | undefined): string {
  return `No channels yet. tm8 only sees a channel it has been invited to: type /invite @${botName || 'tm8'} in the channel in Slack, then reopen this list.`;
}
