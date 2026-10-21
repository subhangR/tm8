/**
 * The TMPDIR every spawned process (agent PTY, chat runtime, shell) gets.
 *
 * The server sets `TM8_SESSION_TMPDIR` to `<dataDir>/tmp`, a directory the
 * `ops.disk-guard` job owns and expires. Without it sessions write to /tmp,
 * which nothing on the node cleans: a killed Vitest run alone leaves a 35-90 MB
 * module dump there. The server's OWN TMPDIR is untouched, because what it
 * keeps there (a sidecar socket fallback) must not be expired.
 *
 * Unset (or the server running without a data dir): the inherited TMPDIR stands.
 */
export function applySessionTmpdir(
  env: Record<string, string | undefined>,
  parentEnv: Record<string, string | undefined>,
): void {
  const managed = parentEnv.TM8_SESSION_TMPDIR;
  if (managed && managed.startsWith('/')) env.TMPDIR = managed;
}
