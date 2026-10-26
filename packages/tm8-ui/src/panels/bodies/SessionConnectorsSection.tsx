/**
 * §10.6 — THE SESSION DEBUG VIEW'S CONNECTOR BLOCK.
 *
 * Two questions, two sources, and the surface keeps them apart because they
 * fail apart:
 *
 *  1. WHAT WAS THIS SESSION GIVEN — from the launch manifest's
 *     `launch.connectors`, the key → id map the launcher was handed (§4.2).
 *     Immutable, written at spawn, and the only place the tool prefix
 *     (`mcp__<serverKey>__*`) can be joined to a connector id.
 *  2. WHO WAS BEHIND IT — from `mcp.sessions.provenance`, which is
 *     `public.mcp_session_provenance`: the recorded root, the bearer chain,
 *     the Spaces it crossed, and whether that root is STILL admitted to every
 *     one of them (§6.2, re-checked live by the function on every read).
 *
 * THE SECOND IS NOT RE-DERIVED HERE, AND MUST NEVER BE. §6 is the access rule
 * that decides whose Gmail an agent may spend; its only implementation is in
 * SQL, where `bind` and every call's `authorize` read it. This component
 * renders the verdict it is handed — including the refusals, passed through —
 * so a reader of this screen is looking at the rule rather than at a browser's
 * impression of it. In particular `rootStillAdmitted: false` is the server's
 * answer, not a membership check done here.
 *
 * `recorded: false` IS A NORMAL ANSWER, not an error (S26): nothing bound this
 * session, or its binding went with its auth session when that was pruned. The
 * empty says so in one sentence and quotes no retention number, because the
 * retain is an operator parameter on `prune_auth_sessions`, not a constant.
 */
import { useEffect, useState } from 'react';
import type { EntityId, McpSessionProvenance } from '@tm8/contract';
import { launchConnectorFacts } from '../../domain';
import { useMcpPort } from '../../mcp/context';
import { DisabledAction } from '../honesty/DisabledWithReason';

type ProvenanceState =
  | { phase: 'absent' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; answer: McpSessionProvenance };

export function ConnectorsSection({
  sessionId,
  manifest,
}: {
  sessionId: EntityId;
  manifest: Record<string, unknown> | null;
}) {
  const port = useMcpPort();
  const read = port?.sessionProvenance;
  const [provenance, setProvenance] = useState<ProvenanceState>({ phase: 'absent' });

  // ONE read, no poll. The binding is written at bind and the chain is fixed;
  // `rootStillAdmitted` is the one live part, and a membership that changes
  // mid-session is not something to spend a request every five seconds on —
  // reopening the tab is the refresh.
  useEffect(() => {
    if (!read) { setProvenance({ phase: 'absent' }); return; }
    let cancelled = false;
    setProvenance({ phase: 'loading' });
    read(sessionId).then(
      (answer) => { if (!cancelled) setProvenance({ phase: 'ready', answer }); },
      (err: unknown) => {
        // The server's refusals reach the screen as themselves. A link session
        // is told it cannot read provenance; an unreadable session says so.
        // Translating either into "no connectors" would hide a permission
        // boundary behind a blank.
        if (!cancelled) {
          setProvenance({
            phase: 'error',
            message: err instanceof Error ? err.message : 'The provenance read failed',
          });
        }
      },
    );
    return () => { cancelled = true; };
  }, [read, sessionId]);

  const facts = launchConnectorFacts(manifest);
  /*
   * The harness surface is SHOWN HERE TOO, beside the note that it is
   * irrelevant, and the redundancy is the point: this is the pairing people
   * come to this screen having got wrong. `describeLaunchManifest` above does
   * not carry the surface, so without this row the note would be a correction
   * to a fact the reader cannot see.
   */
  const surface = harnessSurfaceOf(manifest);
  const harnessNote = manifest === null
    ? null
    : 'Connectors are unaffected by the harness surface: both surfaces run --strict-mcp-config with this session’s own connector bridges, so Full adds none and Lean strips none.';

  return (
    <section className="pn-debug__launch" data-testid="session-debug-connectors">
      <details className="pn-debug__launch-root">
        <summary className="pn-debug__launch-summary">Connectors</summary>
        {facts.length === 0 ? (
          <p className="pn-debug__note">
            This session has no launch manifest, so there is no record of what it was given.
          </p>
        ) : (
          <>
            <div className="pn-debug__fields" data-testid="session-debug-connector-fields">
              {facts.map((fact) => (
                <div className="pn-debug__field" key={fact.label}>
                  <span className="pn-debug__field-label">{fact.label}</span>
                  <span className="pn-debug__field-value" data-mono={fact.mono === true ? 'true' : 'false'}>
                    {fact.value}
                  </span>
                </div>
              ))}
            </div>
            <div className="pn-debug__fields">
              <Fact label="Harness surface" value={surface ?? 'not recorded'} />
            </div>
            {harnessNote ? <p className="pn-debug__note">{harnessNote}</p> : null}
          </>
        )}
        <Provenance state={provenance} />
      </details>
    </section>
  );
}

function Provenance({ state }: { state: ProvenanceState }) {
  if (state.phase === 'absent') {
    return (
      <div className="pn-debug__empty" data-testid="session-debug-provenance-absent">
        <DisabledAction
          label="Connector provenance"
          reason={{
            cause: 'This surface was mounted without a connector port',
            remedy: 'open the session from a space view on a node that serves connectors',
          }}
        >
          Provenance unavailable
        </DisabledAction>
      </div>
    );
  }
  if (state.phase === 'loading') {
    return <p className="pn-debug__note" role="status">Reading connector provenance…</p>;
  }
  if (state.phase === 'error') {
    return (
      <div className="pn-debug__empty" data-testid="session-debug-provenance-error">
        <DisabledAction
          label="Connector provenance"
          reason={{ cause: 'The provenance record could not be read', remedy: state.message }}
        >
          Provenance unavailable
        </DisabledAction>
      </div>
    );
  }
  const { answer } = state;
  if (!answer.recorded) {
    return (
      <p className="pn-debug__note" data-testid="session-debug-provenance-none">
        No connector record for this session. This session never set up connectors, or its record has expired.
      </p>
    );
  }
  const root = answer.rootMemberId ?? answer.rootIdentityId ?? 'an unrecorded root';
  return (
    <div data-testid="session-debug-provenance">
      {/* §6.2's live verdict, FIRST, because it is the one line that explains a
          session whose tools have started failing: the human behind it left a
          Space in the chain, so every connection lent through that chain
          stopped being honoured. */}
      {answer.rootStillAdmitted ? null : (
        <p className="pn-debug__note" role="alert" data-testid="session-debug-provenance-lapsed">
          Connectors stopped working: {root} is no longer a member of every Space this session’s chain crossed.
        </p>
      )}
      <div className="pn-debug__fields">
        <Fact label="Provenance root" value={root} />
        {answer.rootIdentityId === null ? null : <Fact label="Root identity" value={answer.rootIdentityId} />}
        <Fact
          label="Chain"
          // `depth` is `array_length(chain, 1)` and `chain[1]` is this session
          // or chat itself, so one hop IS a direct launch — not an empty chain.
          value={answer.depth <= 1
            ? `Started directly by ${root}`
            : answer.chain.join(' ← ')}
        />
        <Fact label="Spaces crossed" value={answer.chainSpaceIds.join(', ') || 'none recorded'} />
        <Fact label="Root still admitted" value={answer.rootStillAdmitted ? 'yes' : 'no'} />
        {answer.launcherIdentityId === null ? null : (
          <Fact label="Launched by" value={answer.launcherIdentityId} />
        )}
        {answer.launcherAuthKind === null ? null : (
          <Fact label="Launcher credential" value={answer.launcherAuthKind} />
        )}
      </div>
    </div>
  );
}

/** `launch.harness.surface`, read defensively like every other manifest field. */
function harnessSurfaceOf(manifest: Record<string, unknown> | null): string | null {
  const launch = manifest === null ? null : manifest.launch;
  if (typeof launch !== 'object' || launch === null || Array.isArray(launch)) return null;
  const harness = (launch as Record<string, unknown>).harness;
  if (typeof harness !== 'object' || harness === null || Array.isArray(harness)) return null;
  const surface = (harness as Record<string, unknown>).surface;
  return typeof surface === 'string' && surface.trim() !== '' ? surface : null;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="pn-debug__field">
      <span className="pn-debug__field-label">{label}</span>
      <span className="pn-debug__field-value" data-mono="true">{value}</span>
    </div>
  );
}
