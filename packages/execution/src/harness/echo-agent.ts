/**
 * `echo-agent` — the built-in smoke harness.
 *
 * Proves the whole loop (manifest read → PTY spawn → prompt delivery → output)
 * without burning a real model session. HOW-TO-TEST uses this, and it is the
 * designated canary for a staged deploy of the spawn path.
 *
 * It takes NO prompt flags: it reads the typed manifest directly, which is both
 * why its `promptDelivery` is `none` and — historically — why a real defect hid
 * behind it. tm8 once composed a complete manifest and system prompt, wrote them
 * to disk, exported `TM8_MANIFEST_PATH`, then launched a bare `claude` that read
 * none of it. It went unnoticed because echo-agent DOES read the manifest, so
 * the loop passed on a path the product never takes.
 */
import { fileURLToPath } from 'node:url';

import type { ResolvedLaunchConfig } from '../spawn/manifest.js';
import { quoted, type ArgToken, type Harness } from './types.js';

/**
 * The sentinel that selects the built-in smoke agent.
 *
 * DEFINED HERE rather than in `manifest.ts` because it is echo-agent's own
 * business, and because `manifest.ts` and the registry import each other: a
 * `const` read across that cycle at module-initialisation time is a temporal
 * dead zone away from a `ReferenceError`. `manifest.ts` re-exports it, so every
 * existing importer is unaffected.
 */
export const ECHO_AGENT_CMD = 'echo-agent';

/**
 * Absolute path to the built-in echo agent, resolved relative to this module.
 *
 * `../../harness/echo-agent.mjs` lands on the same file from `src/harness/`
 * (vitest, running TypeScript directly) and from `dist/harness/` (the built
 * server) — both are two levels below the package root.
 */
export function echoAgentPath(): string {
  return fileURLToPath(new URL('../../harness/echo-agent.mjs', import.meta.url));
}

export const echoAgentHarness: Harness = {
  id: 'echo-agent',

  /**
   * The selection key is the sentinel, not a real executable: the rendered head
   * is `node`, and the script path is the prelude argument below.
   */
  binary: ECHO_AGENT_CMD,
  exec: 'node',

  capabilities: {
    /** Authenticates with nothing, so per-member credential isolation does not
     *  apply and the §6 refusal rule exempts it. */
    credentialProvider: null,
    configDirName: null,

    /** Reads the typed manifest; tm8 must append no prompt flags. */
    systemPromptDelivery: { kind: 'none' },
    taskPromptDelivery: 'none',

    /**
     * No resume-by-id contract. `null` means REFUSE LOUDLY — a tool that cannot
     * be resumed by exact id must never be silently restarted fresh and
     * presented as resumed.
     */
    resume: null,

    acceptsPreMintedSessionId: false,
    workspaceTrust: 'none',

    /**
     * It runs no arbitrary commands — it reads a manifest and echoes — so
     * confinement is not a question that applies. Deliberately NOT `unconfined`:
     * there is no hazard to report here, rather than a hazard tm8 has chosen to
     * tolerate, and the two must not be collapsed into one word.
     */
    confinement: 'no-command-execution',

    /** tm8 cannot read a transcript for it ⇒ `unsupported_agent_tool`. */
    transcriptDialect: null,
  },

  /** `node <path-to-echo-agent.mjs>` — the path is content and is quoted. */
  preludeArgv(): readonly ArgToken[] {
    return [quoted(echoAgentPath())];
  },

  buildArgv(_launch: ResolvedLaunchConfig): ArgToken[] {
    return [];
  },
};
