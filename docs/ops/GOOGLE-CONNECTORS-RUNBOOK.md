# Runbook: turning on the Google connectors (Gmail, Calendar, Drive)

tm8 serves Gmail, Google Calendar and Google Drive itself, inside the server
process (plan §8.1), because Google hosts no MCP server. The host, its Google
OAuth connect and every tool are built and tested against a fixture Google
(`packages/server/test/mcp/google-fixture.ts`). What is left is configuration
and one live run, below.

## 1. Google Cloud (once per deployment)

1. Create a Google Cloud project for this tm8 deployment.
2. **APIs & Services → Library**: enable the **Gmail API**, the **Google
   Calendar API** and the **Google Drive API**.
3. **OAuth consent screen**: user type **External**, publishing status
   **Testing**. Add every person who will connect as a **test user** (at most
   100 while in Testing).
4. Add these scopes to the consent screen. They are exactly what tm8 asks for
   (`packages/contract/src/mcp-google.ts`); nothing broader:

   | Connector | Scopes |
   |---|---|
   | all three | `openid`, `email` (the account label) |
   | Gmail | `https://www.googleapis.com/auth/gmail.readonly`, `https://www.googleapis.com/auth/gmail.compose` |
   | Calendar | `https://www.googleapis.com/auth/calendar.readonly`, `https://www.googleapis.com/auth/calendar.events` |
   | Drive | `https://www.googleapis.com/auth/drive.file` |

5. **Credentials → Create credentials → OAuth client ID**, type **Web
   application**. Under **Authorized redirect URIs** add exactly:

   ```
   <TM8_PUBLIC_ORIGIN>/mcp/oauth/callback
   ```

   for example `https://tm8.example.com/mcp/oauth/callback`. It is the same
   callback every tm8 connector uses (`packages/server/src/main.ts`, the `mcp`
   block). No JavaScript origin is needed: the code exchange is server-side.

## 2. Server environment

| Variable | Value |
|---|---|
| `TM8_PUBLIC_ORIGIN` | The https origin members open tm8 at. Without it the redirect URI is the loopback bind address and Google refuses it (`redirect_uri_mismatch`). |
| `TM8_GOOGLE_OAUTH_CLIENT_ID` | The OAuth client's **Client ID** (`….apps.googleusercontent.com`). |
| `TM8_MCP_CLIENT_SECRET_GOOGLE` | The OAuth client's **Client secret**. A secret: set it like the other keys, never in a connector definition. |

Restart the server. Both variables are read at every connect and every
refresh, and the secret is never written into a connection, so rotating it is
an env change plus a restart; existing connections keep working.

Until both are set, Connect on a Google connector fails before the consent
screen with "Google connectors are not configured on this server: set
TM8_GOOGLE_OAUTH_CLIENT_ID and TM8_MCP_CLIENT_SECRET_GOOGLE".

## 3. Add the connectors to a Space

A Space admin adds **Gmail**, **Google Calendar** and **Google Drive** from
Connectors → Discover. Each is its own connector and its own connection, on the
one Google client. The definition the card creates:

```json
{ "name": "gmail", "transport": "http", "url": "https://gmail.googleapis.com/gmail/v1",
  "catalogId": "google.gmail", "firstParty": true, "approved": true,
  "auth": { "type": "oauth2", "scopes": ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"] },
  "envKeys": [], "headerKeys": [], "gates": { "gmailSend": false } }
```

The `url` is the connector's identity, not an address tm8 relays to: the host
calls only Google's fixed endpoints. Calendar is
`https://www.googleapis.com/calendar/v3`, Drive `https://www.googleapis.com/drive/v3`.

**Sending email is off.** `send_message` exists only while the connector's
`gmailSend` gate is `true`; absent or `false` it is neither listed nor callable.
Turning it on changes the connector's security revision, so every Gmail
connection must reconnect afterwards.

## 4. The live run (record it on the task)

1. Connect **Gmail** as a test user. The consent screen lists read mail and
   manage drafts, and asks for offline access. After it, the connection shows
   the Google address as its account.
2. **Test** the connector: five tools, `search_messages`, `get_message`,
   `get_thread`, `list_labels`, `create_draft`; no `send_message`.
3. Launch a session with Gmail on and ask it to search the inbox and draft a
   reply. The draft appears in Gmail's Drafts; nothing is sent.
4. Connect **Calendar** with the same account. Google asks only for the
   Calendar scopes (`include_granted_scopes=true`). Ask a session for free time
   tomorrow and to create an event; it appears, with no invitation emailed.
5. Connect **Drive**. `search_files` finds only files created or opened with
   tm8 (`drive.file`): ask a session to create a file, then to find and read it.
6. Refresh: leave a connection idle for more than an hour (access tokens last
   one hour) and use it again; it keeps working.
7. Disconnect the Drive connection. Gmail and Calendar of the same account keep
   working: disconnecting does not revoke at Google, because the three share one
   Google grant and revoking it would end all of them. To remove tm8 from the
   Google account entirely, the person uses
   <https://myaccount.google.com/permissions>; afterwards every remaining
   connection fails its next refresh and must reconnect.

## 5. What to expect afterwards

- **Testing-mode refresh tokens expire after 7 days.** While the consent screen
  is in Testing, Google revokes refresh tokens a week after consent, so
  connections stop and need a reconnect weekly. Publishing the app ends that.
- **Verification.** Gmail's scopes are *restricted*: past 100 users Google
  requires app verification and an annual CASA security assessment. Calendar's
  scopes are *sensitive* (verification only). `drive.file` is neither.
- `redirect_uri_mismatch`: the registered URI and `TM8_PUBLIC_ORIGIN` differ
  (scheme, host, port or trailing slash).
- `Access blocked: … has not completed the Google verification process`: the
  account is not a test user.
- `invalid_client` at connect or refresh: the client ID or secret in the
  environment is wrong or from another project.
