/**
 * The secret scanner (conformance B3 and S6).
 *
 * §18.3 states the rule: "Tokens are passed by scoped environment or protected
 * IPC and never serialized into manifest, graph, logs, prompts, or provider
 * events." The manifest carries the env var NAME; the value lives only in the
 * PTY child's environment.
 *
 * WHY A RUNTIME SCANNER AND NOT JUST A TYPE. The bootstrap manifest has no
 * field that could hold a token — that is a design guarantee and it is enforced
 * by construction. The scanner exists for the artifacts around it: the kernel,
 * the control block, and above all the LOG LINE, which is written by whoever
 * is debugging a spawn at the time and is the artifact nobody re-reads before
 * it ships. A leak there is as permanent as one in the manifest.
 *
 * PHASE-1 HONESTY. There is no bearer authentication today: the server resolves
 * a loopback auto-owner identity from the database. `TM8_AGENT_TOKEN` is the
 * SEAM, modelled now so that the value can never leak once it exists. Nothing
 * here pretends an auth flow is running.
 */

export interface SecretFinding {
  /** Which produced artifact leaked — `manifest`, `kernel`, `log`, … */
  artifact: string;
  /** The env var NAME whose value was found. The value itself is never kept. */
  secretName: string;
  /** Byte offset of the first occurrence, for locating it without printing it. */
  index: number;
}

export class SecretLeakError extends Error {
  readonly findings: readonly SecretFinding[];

  constructor(findings: readonly SecretFinding[]) {
    super(
      `secret leak: ${findings
        .map((f) => `${f.secretName} appears in ${f.artifact} at offset ${f.index}`)
        .join('; ')}`,
    );
    this.name = 'SecretLeakError';
    this.findings = findings;
  }
}

/**
 * Scan every artifact for every secret VALUE.
 *
 * Empty and absent secrets are skipped deliberately: the empty string is a
 * substring of every string, so a scanner that does not skip it reports every
 * artifact as leaking on the very first run with an unset token — and a
 * scanner that cries wolf on run one is switched off by run two. Skipping is
 * safe because an empty secret is not a secret.
 */
export function scanForSecrets(
  artifacts: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string | undefined>>,
): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [secretName, value] of Object.entries(secrets)) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    for (const [artifact, text] of Object.entries(artifacts)) {
      const index = text.indexOf(value);
      if (index !== -1) findings.push({ artifact, secretName, index });
    }
  }
  return findings;
}

/**
 * Throw if anything leaked. The message names the artifact and the env var and
 * NEVER echoes the value — a scanner that prints the secret it found has moved
 * the leak into the log it was protecting.
 */
export function assertNoSecrets(
  artifacts: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string | undefined>>,
): void {
  const findings = scanForSecrets(artifacts, secrets);
  if (findings.length > 0) throw new SecretLeakError(findings);
}
