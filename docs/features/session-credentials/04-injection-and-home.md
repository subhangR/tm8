# 4 — Design: injection and HOME

> Design document, exported from the tm8 graph at entity `019fdc8d-5574-772a-85ce-e9841a7463c1` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 4 — Design — injection and HOME

*Sub-document of “Design: per-member credential management in sessions”. Basis: `origin/main` @ `7631e08`, 2026-08-07.*

### 3.3 Layer 2 — Injection into `composeEnv`

Mirror the existing `AgentCredentialPort` (`spawn/types.ts:73`) — execution stays free of a DB
driver:

```ts
export interface UserCredentialPort {
  resolve(auth: GraphAuth, input: {
    identityId: string; spaceId: string; agentTool: string;
  }): Promise<ResolvedCredentials>;
}

export interface ResolvedCredentials {
  env: Record<string, string>;   // allowlisted NAMES only
  homeDir: string;               // the per-identity agent home
  configDirs: {                  // exported explicitly, belt-and-braces with homeDir
    claude?: string; codex?: string; gh?: string; gitConfig?: string; sshKey?: string;
  };
  policy: 'own' | 'node-fallback' | 'space-shared';   // recorded in the manifest
}
```

`composeEnv` gains one parameter and merges **last**, under one hard rule:

> **Only names on a server-owned per-provider allowlist may be set.** A space member who could
> set an arbitrary env name could set `PATH`, `LD_PRELOAD`, `NODE_OPTIONS`, `BASH_ENV`,
> `GIT_SSH_COMMAND` — that is local code execution as the tm8 user, handed out through a
> settings form. The allowlist is the whole security of this layer.

Audit is free: `envVarNames = Object.keys(env).sort()` already flows to
`graph.recordManifest`, and the S15 trigger already rejects values.

### 3.4 Layer 3 — `HOME` (the substantive work)

Per-identity agent home, `<dataDir>/homes/<identityId>/`, 0700, exported as `HOME`, **plus**
every per-tool config var set explicitly. Two known traps:

1. **`workspace-trust.ts` already honours the override vars** — `CLAUDE_CONFIG_DIR` at :96,
   `CODEX_HOME` at :164. Half of this is pre-plumbed. Its `env` argument is `this.env` (the
   *server's* env) at `SpawnService.ts:556-557`; it must become the *composed* env or trust rows
   land in the wrong home and every session hits the unattended trust dialog.

2. **`withAgentBinDirs` / `agentBinDirCandidates` read `parentEnv['HOME']`** (`manifest.ts:889`)
   to find `~/.local/bin`, `~/.bun/bin`, `~/.volta/bin`. On this node `claude` is at
   `/usr/lib/node_modules/…` but `gh` **is** at `/home/tm8/.local/bin`. If the agent's `HOME`
   changes and this code follows it, `gh` silently leaves `PATH`. **Binary discovery must keep
   using the server's HOME; only the agent's `HOME` moves.** These are the same variable today
   and the split has to be made deliberately.

3. **The shell-profile hole closes as a side effect.** Once `HOME` is tm8-owned, `~/.bashrc` is a
   file tm8 seeds, so tool-use shells stop inheriting `/home/tm8/.profile`'s `GH_TOKEN`.

4. **Git identity, for free.** `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` from the persona,
   `GIT_COMMITTER_*` from the human — git's own author-vs-committer split. This closes
   `docs/identity/IDENTITY-OPEN-THREADS.md` §2, which is open and unowned today.

**Onboarding is a real product surface, not a config file.** A user must be able to *get* a
credential into their home. `claude setup-token` / `gh auth login` / `codex login` are all
interactive device flows. The natural tm8 answer is to run each one **in a PTY the user already
has** — a short-lived, projectless "credential session" with `HOME` set to their own agent home,
streamed to their browser through the existing stream-attach machinery. No new transport.


---

## CORRECTION (review, sub-doc 14): `HOME` alone is not enough — XDG outranks it

`SAFE_BASE_ENV_KEYS` copies `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` from the server environment, and
`gh` prefers `$XDG_CONFIG_HOME/gh` over `$HOME/.config/gh`. **A per-identity `HOME` therefore does
not isolate `gh` if XDG is set.** `composeEnv` must **set or clear the XDG variables explicitly**,
exactly as it does `CLAUDE_CONFIG_DIR`/`CODEX_HOME`. (`composeCredentialEnv` is already safe: it
builds from scratch.) Latent today — XDG is unset on the prod unit — and one operator
`Environment=` line from reverting isolation silently.

Also corrected: the `BASH_ENV` row in sub-doc 11 §I. `BASH_ENV` **is** honoured by `bash -lc`,
not only `bash -c`. The conclusion is unchanged — `HOME` remains the only lever that reaches
*interactive* shells — but the cell was wrong.
