# Codex command networking for tm8 workers

tm8-owned Codex worker launches keep their existing approval posture and use
the `workspace-write` filesystem sandbox. For every sandboxed Codex posture,
tm8 passes these per-process overrides rather than relying on
`~/.codex/config.toml`:

```text
-c 'sandbox_workspace_write.network_access=true'
-c 'features.network_proxy.enabled=true'
-c 'features.network_proxy.domains={"127.0.0.1"="allow", "localhost"="allow"}'
-c 'features.network_proxy.allow_local_binding=false'
```

The first setting enables networking for commands in the `workspace-write`
sandbox. The proxy settings then restrict that enabled traffic to the exact
loopback hosts tm8 uses. This controls command and subprocess traffic; provider
traffic and Codex's web-search tool are separate facilities.

tm8 pins `allow_local_binding=false` even though that is Codex's documented
default. This prevents a developer-global config from silently broadening the
launch to direct loopback, LAN, or private-network access.

Codex exposes its command proxy through standard proxy environment variables.
tm8 also sets `NODE_USE_ENV_PROXY=1` in the worker environment so the
Node-based tm8 CLI's built-in `fetch` honors that proxy; only the variable name,
never a proxy URL or credential, is persisted in manifest diagnostics.

The allow rules are host-based. They do not restrict ports, so an exact
`127.0.0.1` or `localhost` rule can reach loopback services on ports other than
tm8's usual `7778`. Do not describe this policy as a port-level tm8-only grant
unless a future installed Codex version adds a separately tested port control.

## Posture mapping

| tm8 posture | Codex sandbox | Command network |
| --- | --- | --- |
| `auto` | `workspace-write` | loopback proxy |
| `acceptEdits` | `workspace-write` | loopback proxy |
| `interactive` | `workspace-write` | loopback proxy |
| `readOnly` / plan | `workspace-write` | loopback proxy |
| `bypassPermissions` / full access | bypass unchanged | unrestricted by Codex sandbox |

Codex's legacy `read-only` sandbox does not have a documented equivalent of
`sandbox_workspace_write.network_access`. Graph-working plan agents therefore
launch in `workspace-write`, and the trusted tm8 system prompt explicitly
prohibits creating, modifying, renaming, or deleting workspace source files.
This is an authorization rule, not a claim that the filesystem sandbox itself
enforces read-only access.

The persisted manifest records `launch.commandNetwork` independently from
`permissionMode` and `accessMode`. The exact base command remains in
`launch.command`; environment values and session credentials are never added to
that diagnostic record.

Before either spawn or exact-ID resume starts a sandboxed Codex PTY, tm8 invokes
the installed CLI's `features list` with the same network override argv and
checks its runtime version. The launch fails clearly when the overrides cannot
be parsed, `network_proxy` is absent/removed/disabled, or the runtime predates
Codex 0.146.0. Codex 0.145.x advertises the feature but injects loopback/private
hosts into `NO_PROXY`; that makes exact loopback bypass the policy and fail in
the macOS sandbox. Explicit `bypassPermissions` sessions do not use this proxy
and therefore do not run its compatibility preflight.
