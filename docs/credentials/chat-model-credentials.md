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
key; it cannot fall back to a Claude account. Work sessions can additionally
request explicit sources and pin credentials at launch; chat uses automatic
selection and has no per-chat source override in this change.

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
