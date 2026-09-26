/**
 * 992 (W7p): every claims builder that forwards the space pin forwards the
 * link too.
 *
 * `tm8.via_link` is what 093, 206, 083's credential index and
 * `open_space_link_token` refuse on. A builder that copies `sessionSpaceId` off
 * a request identity but drops `viaLinkId` binds a link-bound caller as an
 * ordinary pinned member, and every one of those refusals silently admits. The
 * pin travels through six hand-written builders (facade `claimsFor`, the
 * support routes, the WebSocket claims, the socket identity, PTY attach, the
 * bearer resolver), so this reads the source: any file that SETS
 * `sessionSpaceId` must also mention `viaLinkId`.
 *
 * If you are here because this test failed: forward `viaLinkId` next to
 * `sessionSpaceId`. An exemption needs a reason the claims can never belong to
 * a link-bound caller's credential read.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Sets the key: `sessionSpaceId: x`, or the `{ sessionSpaceId }` shorthand. */
const SETS_PIN = /\bsessionSpaceId:\s*[A-Za-z'"]|\{\s*sessionSpaceId\b/;

const EXEMPT: Readonly<Record<string, string>> = {
  // Claims for an artifact-preview CAPABILITY, pinned to the artifact's
  // space. They read one artifact and its files under RLS, never a
  // credential, and the capability is not an auth session with a link.
  'http/artifact-preview.ts': 'capability viewer claims; no credential read',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

const builders = sourceFiles(SRC)
  .filter((path) => SETS_PIN.test(readFileSync(path, 'utf8')))
  .map((path) => relative(SRC, path))
  .sort();

describe('via_link claim forwarding (992, W7p)', () => {
  it('names the exact set of files that set the space pin', () => {
    // A new builder lands here first, so it is looked at rather than passed.
    expect(builders).toEqual([
      'facade/context.ts',
      'http/artifact-preview.ts',
      'http/identity-resolver.ts',
      'http/support-claims.ts',
      'identity/claims.ts',
      'main.ts',
      'pty/attach-authz.ts',
    ]);
  });

  it('every one of them forwards viaLinkId, or is exempt with a reason', () => {
    const missing = builders.filter(
      (file) => !(file in EXEMPT) && !/\bviaLinkId\b/.test(readFileSync(join(SRC, file), 'utf8')),
    );
    expect(missing).toEqual([]);
  });

  it('every exemption is still a builder (a stale exemption hides nothing)', () => {
    expect(Object.keys(EXEMPT).filter((file) => !builders.includes(file))).toEqual([]);
  });
});
