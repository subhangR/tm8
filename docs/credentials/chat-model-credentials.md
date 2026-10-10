# Chat and session model credentials

Chat and work sessions execute differently. Chat runs a persistent, headless
Claude process over pipes and publishes structured turn output. Sessions run an
agent in a PTY with a launch manifest, task claims, and session lifecycle. Chat
currently supports Claude Code models, including Kimi models served through that
binary; sessions support additional agent tools.

Both paths now select model credentials under the authorizing human's claims
through `resolveSessionCredentials`. For a native Claude model, automatic
selection follows this order, subject to the space and node credential policies:

1. The human's personal default in the space.
2. Their connected member credential.
3. The space default.
4. The node credential, when policy permits it.

Choose a personal default under the space's credential settings or connect a
member credential under Settings → Connections. Those existing settings now
apply to chat too. A Kimi model requires that human's connected, readable Kimi
key; it cannot fall back to a Claude account.

The chat composer's **Chat credentials** picker is available before the opening
message and during an existing conversation. Choose Auto, Mine, Space default,
Server, or a named space credential you may use. The selection belongs to that
chat and survives a reload; it does not change your personal or space default.
Explicit selections refuse unavailable or forbidden credentials rather than
falling back. Kimi models offer only Auto and Mine because they require your
connected backend key.

A mid-chat change is saved immediately and applies to the next claimed turn.
The current answer retains the credential selection it started with. The next
turn rechecks access and policy, and restarts the runtime if the selected account
changes. Switching account directories may reset native model context if the
new account cannot access the transcript; stored tm8 messages remain intact.

The CLI equivalent is `tm8 chat credentials <chat-id> auto|member|space|node`;
append `--credential <space-credential-id>` with `space` to pin a named credential.
Work sessions also support explicit sources and pins at launch.

The model credential is separate from the short-lived tm8 MCP runtime token.
The token authorizes tm8 tools for the current human; it does not log Claude into
an Anthropic account. Chat used to mint that token while leaving model
credentials on the server's `~/.claude` login. That allowed chat and a session
for the same person to run on different Claude accounts.

Chat rechecks credential selection before every turn. A live process is reused
only when its authorizing human, auth kind, model, and selected credential
environment are unchanged. Credential and policy mutations also recheck local
live chats and stop processes whose selections change or become unreadable.
MCP tokens are minted only when starting a process; a reuse check does not
invalidate the token of a running process. This changes model authentication;
GitHub selection and the work-session credential usage view remain separate.

Claude stores native transcripts under its selected config directory. Moving a
chat to a different credential directory can therefore start fresh model
context if that directory has no transcript for the chat's native session id.
Messages stored by tm8 remain intact. This change does not migrate native
transcripts between accounts or alter any existing login.
