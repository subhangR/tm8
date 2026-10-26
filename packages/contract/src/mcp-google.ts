/**
 * The three Google first-party connectors (§8.1, §8.2): what a connector
 * definition for each carries, in one place, so the catalog entries, the SQL
 * catalog and tm8's in-process Google host cannot disagree.
 *
 * `resource` is the connector's URL. tm8 serves these connectors itself, so the
 * URL is an IDENTITY, not an address the proxy fetches: it is the Google REST
 * base the tools act on, it is what the stored connection is bound to
 * (`secret.resource`), and the host calls only its own static Google
 * endpoints, never a definition's URL.
 *
 * `scopes` are the MINIMUM each card needs (§9.3 item 5). `openid` and `email`
 * let tm8 read the account's address from userinfo for the connection's
 * account label (§5.2). Gmail ships read + draft only: `gmail.compose` covers
 * drafts, and sending is a tm8-side gate that ships closed (`gmailSend`).
 */
export interface GoogleFirstPartyService {
  catalogId: 'google.gmail' | 'google.calendar' | 'google.drive';
  /** The definition's `name` and default `serverKey`. */
  name: string;
  resource: string;
  scopes: readonly string[];
}

const IDENTITY_SCOPES = ['openid', 'email'] as const;

export const GOOGLE_FIRST_PARTY: readonly GoogleFirstPartyService[] = [
  {
    catalogId: 'google.gmail', name: 'gmail', resource: 'https://gmail.googleapis.com/gmail/v1',
    scopes: [...IDENTITY_SCOPES, 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
  },
  {
    catalogId: 'google.calendar', name: 'calendar', resource: 'https://www.googleapis.com/calendar/v3',
    scopes: [...IDENTITY_SCOPES, 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'],
  },
  {
    catalogId: 'google.drive', name: 'drive', resource: 'https://www.googleapis.com/drive/v3',
    scopes: [...IDENTITY_SCOPES, 'https://www.googleapis.com/auth/drive.file'],
  },
];

/** The gate that turns Gmail's `send_message` on. Absent or false: closed. */
export const GMAIL_SEND_GATE = 'gmailSend';

/** Google's own authorization server. Fixed: Google needs no discovery (G6). */
export const GOOGLE_OAUTH_ISSUER = 'https://accounts.google.com';

export function googleFirstPartyService(catalogId: string | undefined): GoogleFirstPartyService | undefined {
  return GOOGLE_FIRST_PARTY.find(service => service.catalogId === catalogId);
}
