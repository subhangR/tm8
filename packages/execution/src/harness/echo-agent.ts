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
import type { ResolvedLaunchConfig } from '../spawn/manifest.js';
import { echoAgentPath, ECHO_AGENT_CMD } from '../spawn/manifest.js';
import { quoted, type ArgToken, type Harness } from './types.js';

export const echoAgentHarness: Harness = {
  id: 'echo-agent',

  /**
   * The registry key for binary lookup is the sentinel `ECHO_AGENT_CMD`, not a
   * real executable: the rendered head is `node`, and the script path is the
   * prelude argument below.
   */
  binary: ECHO_AGENT_CMD,

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
  preludeArgv: [quoted(echoAgentPath())],

  buildArgv(_launch: ResolvedLaunchConfig): ArgToken[] {
    return [];
  },
};
