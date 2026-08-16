/**
 * SPECIMEN VALUES — the oracle's own strings, and nothing else.
 *
 * READ THE NAME OF THIS FILE. Every value here is transcribed verbatim from
 * "T3 Auth & Onboarding Flows.dc.html" so the built screens can be diffed
 * against the canvas at the pixel level. NONE of it is data. There is no seam
 * capability behind any of it (see `reasons.ts` for the measurement), so the
 * frames render these while every verb beside them refuses.
 *
 * WHY A FILE AND NOT LITERALS IN THE FRAMES: so the set is countable. When an
 * auth seam lands, the compiler points at every place a specimen is consumed
 * — the import list IS the porting checklist. Inline strings would have to be
 * hunted, and hunting is how a specimen survives into production as a fact.
 *
 * The one number deliberately ABSENT: the account menu's "2" access-token
 * pill (oracle L418). There is no token operation, so a count there would be
 * invented rather than transcribed, and a number is the one kind of specimen a
 * reader cannot tell from a fact. T1-4's hollow-value law applies: dash, never
 * a digit.
 */

/** The server every frame is drawn against. Oracle L36, L105, L136. */
export const SERVER = {
  name: 'forge',
  glyph: 'F',
  /** Oracle L36 (first-run) — the unclaimed node identifies by version + host. */
  unclaimedMeta: 'tm8-server v0.9.2 · localhost:8787',
  /** Oracle L77 — once named, the host line carries the name. */
  namedMeta: 'forge · localhost:8787',
  /** Oracle L103 — the login stage's right-hand chrome. */
  secureMeta: 'connection secure · tls',
  /** Oracle L176. */
  hostMeta: 'forge.tm8.dev',
  /** Oracle L200, L250 — the redeem landing's URL. */
  joinMeta: 'forge.tm8.dev/join/K7XM…',
  /** Oracle L105 — the websocket endpoint under the server name. */
  endpoint: 'wss://forge.tm8.dev',
  /** Oracle L309 — how a resolved server identifies itself. */
  resolvedMeta: 'tm8-server v0.9.2 · protocol v3',
  /* GATE COPY — not oracle. The chrome must claim exactly what it has: a
     server-backed sign-in against the node this browser is pointed at. */
  localMeta: 'server sign-in · auth.login',
  localEndpoint: 'account on this server',
} as const;

/** 1a — the claim step. Oracle L39–L44. */
export const CLAIM = {
  title: 'This server is unclaimed.',
  body: 'tm8 is running with no owner. The first account created here becomes the owner — full admin over accounts, projects, and spaces.',
  name: 'amber',
  nameHint: 'handle @amber — how agents and members mention you',
  password: '••••••••••',
  passwordHint: '8+ characters · stored only on this server',
  action: 'Create owner account',
  actionBusy: 'Creating…',
  footer: 'local connection · nothing leaves this machine',

  /* ── GATE COPY (not oracle transcription — see the note below) ────────── */
  /**
   * These strings are NOT from the canvas. The oracle was drawn for a server
   * that claims itself; this gate creates a real account ON the server via
   * auth.signup, and the copy has to say what actually happens. Kept beside
   * the transcription so the two are never confused: everything above this
   * line is the oracle's, everything below is ours and is load-bearing
   * honesty.
   */
  gateTitle: 'Create your account on this server.',
  /** Not "Create owner account": auth.signup never mints an owner (the
      loopback owner already exists), and a button must not promise a role
      the operation cannot grant. */
  gateAction: 'Create account',
  gateBody:
    'This creates a real account on the tm8 node (auth.signup) and signs you in (auth.login). Account creation is the node admin’s act: from the server’s own machine it is authorized automatically; on a shared server it may be refused — ask the operator for an account and a space invite.',
  /**
   * The UNCLAIMED first-run body — and a different act from `gateBody`. On a
   * node nobody has claimed the card performs `auth.claim`, authorized by the
   * setup TOKEN, not by a node-admin session. That path works from ANY machine
   * — it is the entire point of the claim lane (design §3.2, §5.1) — so the
   * copy must not repeat `gateBody`'s "on a shared server it may be refused"
   * dead end, which describes the door this lane was built to remove. Contains
   * "on the tm8 node" because that is literally where the credential is set.
   */
  claimTitle: 'Claim this node.',
  claimBody:
    'No one owns this node yet. The setup token printed at first boot authorizes you to claim it — from any machine, not just the server’s own (auth.claim). Pick an owner handle and password; they’re set on the tm8 node, you’re signed in, and you hold full admin over accounts, projects, and spaces.',
  handleHintTail: 'how agents and members mention you',
  nameHintEmpty: 'your handle is derived from this name',
  gatePasswordHint: '8+ characters · sent to this server, stored only as a hash — use HTTPS off this machine',
  gateFooter: 'the password goes to this tm8 node and nowhere else',
  toSignIn: 'already have an account? sign in',
  backToSignIn: '← back to sign in',
  anotherTitle: 'Create another account.',
  anotherBody:
    'Accounts on this server are separate people. Creating another registers it on the node alongside the first — you can sign in as either.',
  anotherAction: 'Create account',
  stepsNote:
    'Steps 2 and 3 of the oracle’s first run — name the server, create the first space — are not connected: nothing sets a server’s name, and spaces.create is a contract operation the seam does not expose. The gate completes at step 1.',
} as const;

/** 1b — naming the server. Oracle L58–L66. */
export const NAME_STEP = {
  title: 'Name the server.',
  body: 'Like a Discord server: the domain everyone connects to. This is how it appears in your rail and to anyone you invite.',
  tilePreviewHint: 'rail tile preview · glyph from the name',
  name: 'forge',
  swatchNote: 'brass, selected',
  action: 'Continue',
} as const;

/** 1c — the first space. Oracle L80–L85. */
export const FIRST_SPACE = {
  title: 'Create your first space.',
  body: 'A space is the sharing boundary — its own graph, members, and menu. Everything you and your agents make lives in one. Add more anytime.',
  name: 'atelier',
  menuNote:
    'Starts with the default menu — Home · Workspace · Channels · Settings. Admins reshape it later; the menu is data, not chrome.',
  action: 'Create space & enter',
  footer: 'lands in the workspace → orientation, flow C',
} as const;

/** 1d — the returning-member login. Oracle L106–L123. */
export const LOGIN = {
  title: 'Welcome back.',
  handle: '@amber',
  password: '••••••••••',
  token: 'tm8_tok_9f2kq…',
  tokenHint: 'created under Account → Access tokens on this server',
  passwordAction: 'Sign in',
  busyAction: 'Signing in…',
  toCreateAnother: 'create another account',
  tokenAction: 'Sign in with token',
  toToken: 'use an access token instead',
  toPassword: 'use a password instead',
  footer:
    'No self-serve signup — accounts on forge are created by invite. Have a link? It opens flow C.',
  /* GATE COPY — not oracle. The oracle footer names "forge" (a specimen
     server) and "flow C" (reviewer vocabulary), neither of which a real
     signed-out viewer should be shown. The live gate says what is actually
     true of THIS node: sign-in mints a session (auth.login), and a new
     account here is a node-admin act, not self-serve. */
  gateFooter:
    'No self-serve signup here — a node admin creates accounts. Signing in starts a session on this node (auth.login).',
} as const;

/**
 * 1e — the failed sign-in. Oracle L138–L142.
 *
 * The attempt numbers are the sharpest specimen on the board: "4 attempts
 * left, then a 5-minute hold" reads as a fact the server computed, and no
 * server computed it. The frame renders them under an explicit specimen
 * marker for exactly that reason.
 */
export const LOGIN_FAILED = {
  banner: 'Sign-in failed',
  bannerBody: '— wrong password for @amber. 4 attempts left, then a 5-minute hold on this handle.',
  fieldLabel: 'PASSWORD · FAILED',
  password: '••••••••',
  action: 'Try again',
  footer:
    'No email on this server — password resets go through the owner: @amber can reset any account under Members.',
} as const;

/** 1f — expiry, re-auth over the dimmed workspace. Oracle L161–L166. */
export const EXPIRED = {
  eyebrow: 'SESSION EXPIRED',
  title: 'Sign back in as amber.',
  body: 'Your token expired after 30 days. Panels, pins, and tabs live in the URL — nothing is lost, and live sessions kept running.',
  action: 'Sign in & resume',
  switchPrefix: 'not amber? ',
  switchLink: 'sign in as someone else',
  switchSuffix: ' — this clears the kept view',
} as const;

/** 1g — the signed-out landing. Oracle L179–L182. */
export const SIGNED_OUT = {
  title: 'You’re signed out of forge.',
  body: 'This browser’s session is cleared. Your entities, spaces, and running agents stay on the server — signing out stops nothing.',
  action: 'Sign back in',
  /** Oracle L182 renders "2 live sessions". The COUNT is a prop, never this. */
  liveSuffix: 'still running · visible after sign-in',

  /* GATE COPY — not oracle. Now TRUE in the way the oracle promised: the
     session is revoked on the server (auth.logout), and everything you made
     stays there. */
  gateBody:
    'Your session on this server is revoked. Your account, entities, spaces, and running agents stay on the server — signing out stops nothing.',
  gateNote:
    'Sign-out revokes the tm8s session pass on the server and forgets it here. Sign back in anytime.',
} as const;

/** 1h — the invite redeem landing. Oracle L202–L209. */
export const REDEEM = {
  inviter: 'nadia',
  inviterInitial: 'N',
  invitedBy: 'invited you',
  title: 'You’re invited to atelier.',
  space: 'atelier',
  body: 'One account on forge works across every space you’re invited to. 4 members and 3 agent teammates are already in atelier.',
  name: 'kit',
  nameHint: 'handle @kit',
  password: '•••••••••',
  action: 'Join atelier',
  footerPrefix: 'single use · expires jul 30 · already have an account on forge? ',
  footerLink: 'sign in',
} as const;

/** 1j — the three orientation points. Oracle L231–L241. */
export const ORIENTATION = {
  points: [
    {
      n: '1',
      title: 'Spaces are the boundary',
      body: 'Each space up here has its own graph, members, and menu. You’re in ',
      emphasis: 'atelier',
      bodyTail: '.',
    },
    {
      n: '2',
      title: 'Agents are teammates',
      body: 'They plan, run, and reply in the same rooms as you. Sessions are their live terminals — the ',
      /** The inline live dot + word. D22: `live` is the bar's word, and this IS a bar-count sentence. */
      liveWord: 'live',
      bodyTail: ' dot means one is working right now.',
    },
    {
      n: '3',
      title: 'Click anything',
      body: 'Every task, doc, session, or person opens as a panel — talk about it right where it lives. Press ',
      /** D36/D37: `/` is the palette's guaranteed path everywhere, and the oracle draws `/` here. */
      key: '/',
      bodyTail: ' for the palette.',
    },
  ],
  action: 'Got it',
  actionNote: 'shown once, never again',
} as const;

/** 1i — the dead invite. Oracle L252–L261. */
export const INVITE_DEAD = {
  eyebrow: 'INVITE REVOKED',
  title: 'This invite no longer works.',
  body: 'nadia’s invite to atelier was revoked by @amber on jul 24. Invites are single-use links — ask nadia for a new one.',
  /**
   * "Same card for all three — the word changes, never color alone."
   * The tone differs per word BECAUSE the word carries the meaning; the tone
   * is the second signal, never the only one.
   */
  legend: [
    { word: 'REVOKED', tone: 'block' as const, gloss: 'pulled back by an admin — this one' },
    { word: 'EXPIRED', tone: 'wait' as const, gloss: 'past its 7-day window' },
    { word: 'USED', tone: 'idle' as const, gloss: 'someone already joined with it' },
  ],
  footer:
    'Same card for all three — the word changes, never color alone. No space details leak on a dead link.',
} as const;

/** 1k — the add-server dialog. Oracle L288–L292. */
export const ADD_SERVER = {
  title: 'Add server',
  body: 'Connect another tm8 server. Its spaces and menu appear in your rail as a group — one client, many servers.',
  endpoint: 'wss://forge.tm8.dev',
  endpointHint: 'a server, or a gateway that hosts several — we resolve it',
  nicknamePlaceholder: 'defaults to the server’s own name',
  cancel: 'Cancel',
  action: 'Connect',
} as const;

/** 1l — resolved, now authenticate. Oracle L306–L319. */
export const RESOLVED = {
  title: 'Add server',
  reachable: 'reachable',
  body: 'forge asks who you are. Use an access token minted there, or your member credentials.',
  tabs: ['Access token', 'Password'] as const,
  token: 'tm8_tok_9f2kq04sh…',
  tokenHint: 'minted on forge under Account → Access tokens (1q)',
  back: 'Back',
  action: 'Add forge',
} as const;

/** 1o — the success toast. Oracle L342. */
export const SERVER_ADDED = {
  lead: 'forge added',
  body: ' — signed in as @amber. 2 spaces joined your rail.',
} as const;

/** 1m — the gateway branch. Oracle L354–L360. */
export const GATEWAY = {
  title: 'Add server',
  host: 'hub.tm8.dev',
  bodyTail: ' is a gateway — it routes to 3 servers. Pick which to add; each signs you in separately.',
  servers: [
    { glyph: 'F', name: 'forge', meta: '2 spaces visible · you’re a member', state: 'joinable' as const },
    { glyph: 'L', name: 'lumen', meta: 'invite required — ask a lumen admin', state: 'invite' as const },
    { glyph: 'D', name: 'dockyard', meta: 'maintenance — back around 18:00 utc', state: 'down' as const },
  ],
  back: 'Back',
  action: 'Continue to forge',
} as const;

/** 1n — the three ways a connection fails. Oracle L371–L384. */
export const CONNECT_FAILURES = [
  {
    tone: 'block' as const,
    eyebrow: 'UNREACHABLE',
    body: 'Nothing answered at forge.tm8.dev:443 — dns resolved, connection refused. Wrong port, or the server is down.',
    evidence: 'ECONNREFUSED 203.0.113.7:443 · 3 attempts over 12s',
    primary: 'Retry',
    secondary: 'Edit URL',
  },
  {
    tone: 'block' as const,
    eyebrow: 'AUTH REFUSED',
    body: 'forge rejected this token — revoked by @amber on jul 20. Mint a new one on forge under Account → Access tokens.',
    evidence: null,
    primary: 'Try another token',
    secondary: 'Use password',
  },
  {
    tone: 'wait' as const,
    eyebrow: 'VERSION MISMATCH',
    body: 'forge speaks protocol v5; this client speaks v3. Connecting could corrupt state — update the app, then retry.',
    evidence: null,
    primary: 'How to update',
    secondary: 'Dismiss',
  },
] as const;

/** 1p — the account menu rows. Oracle L416–L422. */
export const ACCOUNT_MENU = {
  profile: 'Profile — name, avatar, password',
  appearance: 'Appearance',
  tokens: 'Access tokens',
  actAs: 'Act as teammate…',
  actAsPill: 'phase 2',
  signOut: 'Sign out of forge',
  signOutNote: 'clears this browser only — agents keep running',
  /* GATE COPY — not oracle. This sign-out is a real server act: auth.logout
     revokes the session pass, and the copy says exactly that. */
  gateSignOutNote: 'revokes this session on the server — agents keep running',
} as const;

/** 1q — the token surface. Oracle L433–L448. */
export const TOKENS = {
  eyebrow: 'ACCOUNT · ACCESS TOKENS',
  action: 'New token',
  body: 'Tokens sign other clients into forge as you — the laptop at home, the CLI, another tm8 app adding forge as a remote (1l). Revoking one signs that client out within 60s.',
  fresh: {
    name: 'studio-laptop',
    pill: 'NEW',
    secret: 'tm8_tok_9f2kq04shTe6…vXc1',
    copy: 'copy',
    onceLead: 'Shown once.',
    onceBody: ' Copy it now — forge stores only a hash.',
  },
  rows: [
    {
      name: 'cli @ workstation',
      meta: 'created jun 2 · last used 4 min ago',
      status: 'active' as const,
      tone: 'run' as const,
      revoked: false,
    },
    {
      name: 'old-macbook',
      meta: 'created feb 14 · last used 3 months ago',
      status: 'idle' as const,
      tone: 'idle' as const,
      revoked: false,
    },
    {
      name: 'home-desktop',
      meta: 'revoked jul 20 by @amber',
      status: 'revoked' as const,
      tone: 'block' as const,
      revoked: true,
    },
  ],
} as const;
