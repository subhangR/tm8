/**
 * T3-5 — NODE SETTINGS & STATUS, "the machine room, on graphite". Oracle:
 * `T3 Files, Node & Inbox Hi-Fi.dc.html` L132–L243, read whole.
 *
 * ══ THE ONE SENTENCE THAT GOVERNS THIS SCREEN ═══════════════════════════
 * The oracle's own header says "health payload already exists — this renders
 * it". THAT IS NOT TRUE OF THIS CONTRACT. All 102 operations in
 * `@tm8/contract`'s `catalog.ts` were listed and searched on 2026-07-29 for
 * node / health / backup / provider: zero hits (the sole match is a comment
 * about a Phase-2 `bridge.fetchBlob` that must answer an honest 501). There
 * is no uptime, no rss, no database size, no vacuum time, no ws client count,
 * no provider registry, no concurrency cap, no backup.
 * ════════════════════════════════════════════════════════════════════════
 *
 * So this screen is built around the two node facts the seam CAN measure, and
 * every other number on it is a dash with a caption:
 *
 *   REACHABILITY — `seam.getConnection()`. The connection honesty states are
 *       a genuine verdict about this node: 'live' (WS open, events flowing),
 *       'polling' (WS down, HTTP catch-up working — degraded, and it names
 *       since when), 'offline' (nothing is reaching the node). This maps onto
 *       the oracle's server row exactly: dot + word + facts + status word.
 *   LIVE SESSIONS — `seam.liveness`. `liveEntityIds.length` is a measured
 *       count from the node's own in-process PTY map, and `nodeBootId` is a
 *       real node-process identity that rotates on restart.
 *
 * Everything dashed here obeys T1-4 / D7.2: zero means measured-zero, dash
 * means not-measured. Transcribing the oracle's "up 14d 6h" would have been
 * the easy, plausible, false thing to do — this file exists partly to make
 * that refusal visible.
 *
 * GRAPHITE IN BOTH THEMES is the oracle's own ruling (L237: "Node surfaces
 * are graphite in both themes — like the registry (T2-2), the machine room
 * reads terminal-adjacent"). Implemented as D16/D24's mechanism: a nested
 * `.cv2-root[data-theme="dark"]` scope re-declaring the real dark tokens
 * through tokens.css's own selector. Zero duplicated hex, cannot drift.
 */
import { useEffect, useState } from 'react';
import { Eyebrow, Pill } from '../kit';
import { DisabledAction, HollowInline } from '../panels';
import type { ConnectionState } from '../data/seam';
import type { NodeFacts, NodePort } from './port';
import {
  BACKUP_NOW_UNAVAILABLE,
  CONCURRENCY_CAP_UNKNOWN,
  NODE_HEALTH_UNAVAILABLE,
  NODE_MEASURABLE_NOTE,
  PROVIDER_ADD_UNAVAILABLE,
  PROVIDER_LIST_UNAVAILABLE,
  PROVIDER_TEST_UNAVAILABLE,
  RESTORE_UNAVAILABLE,
} from './reasons';

/**
 * A provider row the HOST supplies. There is no registry read, so this lane
 * invents none: with no rows the card says so rather than drawing plausible
 * `claude` and `openai` entries copied off the canvas.
 */
export interface ProviderRow {
  name: string;
  /** The command template, `{workdir}` / `{profile}` vars intact. */
  command: string;
  /** Last probe outcome, if a host ever has one. `null` ⇒ never probed. */
  lastTest?: { ok: boolean; detail: string } | null;
}

export interface NodeRoomProps {
  port: NodePort;
  /** Display name of the node, e.g. "dockyard". Hollow when unknown. */
  nodeName?: string | null;
  /** Server version string. Hollow when unknown. */
  version?: string | null;
  providers?: readonly ProviderRow[];
  /**
   * The oracle's own annotation switch (`<sc-if value="{{notes}}">`, L235) —
   * the band and the per-card captions are canvas annotations, not product
   * copy. Default `false`; the review board turns them on. Same ruling as
   * FilesScreen's `notes`.
   */
  notes?: boolean;
}

export function NodeRoom(props: NodeRoomProps) {
  const facts = useNodeFacts(props.port);
  const notes = props.notes ?? false;
  return (
    <div
      className="cv2-root fn-node" data-astryx-theme="neutral"
      data-theme="dark"
      data-always-dark="true"
      data-testid="node-room"
    >
      <div className="fn-cols">
        <NodeStatusCard
          facts={facts}
          nodeName={props.nodeName ?? null}
          version={props.version ?? null}
          notes={notes}
        />
        <AgentCommandsCard providers={props.providers ?? []} notes={notes} />
        <DataBackupCard notes={notes} />
      </div>
      {notes ? <NodeNotes /> : null}
    </div>
  );
}

/**
 * Subscribes once and re-reads through the port. The port is the ONLY seam
 * contact; this hook adds no second call site, and `refresh()` on mount is
 * the screen's single act — a read, not a command.
 */
export function useNodeFacts(port: NodePort): NodeFacts {
  const [facts, setFacts] = useState<NodeFacts>(() => port.facts());
  useEffect(() => {
    setFacts(port.facts());
    const off = port.subscribe(setFacts);
    void port.refresh();
    return off;
  }, [port]);
  return facts;
}

// ===========================================================================
// NODE STATUS (oracle L139–L187)
// ===========================================================================

/**
 * The connection state → the oracle's row vocabulary. This is the two-source
 * honesty law (design law 7) applied to the node itself: the VERDICT is the
 * seam's, computed nowhere else, and this function only dresses it.
 */
export function connectionRow(state: ConnectionState): {
  word: string;
  tone: 'run' | 'wait' | 'block' | 'idle';
  facts: string;
  pulse: boolean;
} {
  switch (state.phase) {
    case 'live':
      return { word: 'healthy', tone: 'run', facts: 'websocket open · events flowing', pulse: false };
    case 'connecting':
      return { word: 'connecting', tone: 'idle', facts: 'opening the event stream', pulse: true };
    case 'polling':
      return {
        word: 'degraded',
        tone: 'wait',
        // The consequence, not just the cause — the oracle's degraded row
        // names both (L166: "runs with it fail with reason").
        facts: `websocket down since ${state.disconnectedSince} · HTTP catch-up succeeding, data advances slower`,
        pulse: true,
      };
    case 'offline':
      return {
        word: 'unreachable',
        tone: 'block',
        facts: `nothing reaching the node since ${state.disconnectedSince}`,
        pulse: false,
      };
  }
}

function NodeStatusCard({
  facts,
  nodeName,
  version,
  notes,
}: {
  facts: NodeFacts;
  nodeName: string | null;
  version: string | null;
  notes: boolean;
}) {
  const server = connectionRow(facts.connection);
  // The header verdict is the WORST subsystem word, and it is derived from
  // the same one source as the row — never a second opinion. Only the server
  // row has a verdict, so the header cannot claim more than it does.
  const overall = server;

  return (
    <section className="fn-card fn-card--dark" data-testid="node-status-card">
      <div className="fn-card__head">
        <h3 className="fn-card__title">Node status</h3>
        <span className="fn-card__sub">
          {nodeName ?? <HollowInline caption={NODE_HEALTH_UNAVAILABLE.cause}>— node</HollowInline>}
          {' · '}
          {version ?? <HollowInline caption={NODE_HEALTH_UNAVAILABLE.cause}>— version</HollowInline>}
        </span>
        <div className="fn-spacer" />
        <Pill tone={overall.tone} dot={overall.pulse ? 'pulse' : 'solid'}>
          {overall.word}
        </Pill>
      </div>

      {/* SERVER — the one fully measured row on this card. */}
      <SubsystemRow
        name="server"
        tone={server.tone}
        pulse={server.pulse}
        facts={server.facts}
        word={server.word}
      />

      {/* DATABASE — nothing anywhere reports it. Dashes, with the reason. */}
      <SubsystemRow
        name="database"
        tone="idle"
        pulse={false}
        facts={null}
        word={null}
        reason={NODE_HEALTH_UNAVAILABLE}
      />

      {/* AGENT HOST — partially measured: the live-session count is real, the
          provider health is not. Saying "3 sessions live" while dashing the
          provider state is exactly the two-facts-one-row case the honesty
          treatments exist for. */}
      <SubsystemRow
        name="agent host"
        tone="idle"
        pulse={false}
        word={null}
        reason={NODE_HEALTH_UNAVAILABLE}
        facts={
          facts.liveSessionCount === null
            ? null
            : `${facts.liveSessionCount} ${facts.liveSessionCount === 1 ? 'session' : 'sessions'} live${
                facts.checkedAt ? ` · checked ${facts.checkedAt}` : ''
              }`
        }
      />

      <ConcurrencyStrip facts={facts} />

      {/* NOT an annotation: the measurable-note sentence is the card's own
          explanation of why some rows are live and others are dashes, and a
          user who cannot see it reads the dashes as a bug. It stays on. */}
      <p className="fn-note fn-note--dark">{NODE_MEASURABLE_NOTE}</p>
      {notes ? (
        <p className="fn-note fn-note--dark">
          status — each subsystem: dot + word + mono facts; degraded names the cause and the
          consequence
        </p>
      ) : null}
    </section>
  );
}

function SubsystemRow({
  name,
  tone,
  pulse,
  facts,
  word,
  reason,
}: {
  name: string;
  tone: 'run' | 'wait' | 'block' | 'idle';
  pulse: boolean;
  facts: string | null;
  word: string | null;
  reason?: { cause: string; remedy?: string };
}) {
  return (
    <div className="fn-sub" data-testid="subsystem-row" data-subsystem={name}>
      <span className={`fn-sub__dot fn-sub__dot--${tone}${pulse ? ' fn-sub__dot--pulse' : ''}`} aria-hidden />
      <span className="fn-sub__name">{name}</span>
      <span className="fn-sub__facts">
        {facts ?? (
          <HollowInline caption={reason ? `${reason.cause} — ${reason.remedy ?? ''}` : ''}>
            — not measured
          </HollowInline>
        )}
      </span>
      <span className="fn-sub__word">
        {word ?? (
          <HollowInline caption={reason ? `${reason.cause} — ${reason.remedy ?? ''}` : ''}>—</HollowInline>
        )}
      </span>
    </div>
  );
}

/**
 * CONCURRENCY (oracle L168–L184). The oracle draws eight pills: three filled,
 * five hollow, "8 slots · 3 in use".
 *
 * The IN-USE half is real (liveness). The CAP is not: the contract has a
 * `capacity` refusal code for hitting the ceiling and NO operation that
 * reports it. Drawing eight pills would invent the 8 — the exact shape of
 * lie D7.2 forbids, just spatial instead of numeric. So the strip renders one
 * pill per live session and then states, in words, that the ceiling is
 * unknown. The oracle's "at 8/8, Run disables with concurrency cap reached"
 * sentence survives as the mechanism it names, with the number withheld.
 */
function ConcurrencyStrip({ facts }: { facts: NodeFacts }) {
  const inUse = facts.liveSessionCount;
  return (
    <div className="fn-conc" data-testid="concurrency">
      <div className="fn-conc__head">
        <Eyebrow faint>CONCURRENCY</Eyebrow>
        <span className="fn-conc__count">
          {inUse === null ? (
            <HollowInline caption="no liveness snapshot has been read yet">— in use</HollowInline>
          ) : (
            `${inUse} in use`
          )}
          {' · '}
          <HollowInline caption={CONCURRENCY_CAP_UNKNOWN}>— slots</HollowInline>
        </span>
      </div>
      <div className="fn-conc__pills" data-testid="concurrency-pills" data-inuse={inUse ?? 'unknown'}>
        {Array.from({ length: inUse ?? 0 }, (_, i) => (
          <span key={i} className="fn-conc__pill fn-conc__pill--used" aria-hidden />
        ))}
        {/* No hollow pills. A hollow pill is a claim about how many slots
            exist, and that number is the one thing this build cannot know. */}
        <span className="fn-conc__unknown">
          {/* The dash is part of the phrase, per HollowInline's own contract
              ("pass a unit phrase like `— viewing`"): the mark that means
              not-measured must be VISIBLE, not implied by the wording. */}
          <HollowInline caption={CONCURRENCY_CAP_UNKNOWN}>— remaining slots unknown</HollowInline>
        </span>
      </div>
      <p className="fn-conc__note">
        at the cap, Run disables with “concurrency cap reached” (T1-4) — the refusal exists; the
        ceiling it counts against is not readable here.
      </p>
    </div>
  );
}

// ===========================================================================
// AGENT COMMANDS (oracle L188–L216)
// ===========================================================================

function AgentCommandsCard({
  providers,
  notes,
}: {
  providers: readonly ProviderRow[];
  notes: boolean;
}) {
  return (
    <section className="fn-card fn-card--dark" data-testid="agent-commands-card">
      <div className="fn-card__head">
        <h3 className="fn-card__title">Agent commands</h3>
        <div className="fn-spacer" />
        <DisabledAction reason={PROVIDER_ADD_UNAVAILABLE} label="Add a provider">
          <span className="fn-btn fn-btn--brass">＋ Provider</span>
        </DisabledAction>
      </div>

      {providers.length === 0 ? (
        <div className="fn-provider-empty" data-testid="providers-empty">
          <p className="fn-provider-empty__line">No provider registry is readable on this node.</p>
          <span className="fn-provider-empty__why">{PROVIDER_LIST_UNAVAILABLE.remedy}</span>
        </div>
      ) : (
        providers.map((provider) => <ProviderCard key={provider.name} provider={provider} />)
      )}

      {notes ? (
        <p className="fn-note fn-note--dark">
          commands — template vars {'{workdir}'} {'{profile}'}; test launch shows real exit +
          stderr, not “something went wrong”
        </p>
      ) : null}
    </section>
  );
}

function ProviderCard({ provider }: { provider: ProviderRow }) {
  const test = provider.lastTest ?? null;
  return (
    <div
      className={`fn-provider${test && !test.ok ? ' fn-provider--bad' : ''}`}
      data-testid="provider-row"
    >
      <div className="fn-provider__head">
        <span className="fn-provider__name">{provider.name}</span>
        {test === null ? (
          <HollowInline caption={PROVIDER_TEST_UNAVAILABLE.remedy ?? ''}>— never probed</HollowInline>
        ) : (
          <Pill tone={test.ok ? 'run' : 'block'}>{test.ok ? '✓ ok' : '✗ test failed'}</Pill>
        )}
        <div className="fn-spacer" />
        <DisabledAction reason={PROVIDER_TEST_UNAVAILABLE} label={`Test launch ${provider.name}`}>
          <span className="fn-btn fn-btn--ghost">test launch ▸</span>
        </DisabledAction>
      </div>
      <code className="fn-provider__cmd">{provider.command}</code>
      {test && !test.ok ? <pre className="fn-provider__err">{test.detail}</pre> : null}
    </div>
  );
}

// ===========================================================================
// DATA & BACKUP (oracle L217–L233)
// ===========================================================================

function DataBackupCard({ notes }: { notes: boolean }) {
  return (
    <section className="fn-card fn-card--dark" data-testid="data-backup-card">
      <Eyebrow faint>DATA &amp; BACKUP</Eyebrow>

      {/* Four rows, four dashes. Every one of these is a real fact about a
          real node that NOTHING in this build can read — and the row is drawn
          anyway, because "unavailable ≠ invisible": a user who cannot see
          that backups exist cannot ask why they are missing. */}
      <dl className="fn-grid" data-testid="data-grid">
        <DataRow label="database" caption={NODE_HEALTH_UNAVAILABLE.cause} />
        <DataRow label="files store" caption={NODE_HEALTH_UNAVAILABLE.cause} />
        <DataRow label="last backup" caption={BACKUP_NOW_UNAVAILABLE.cause} />
        <DataRow label="schedule" caption={BACKUP_NOW_UNAVAILABLE.cause} />
      </dl>

      <div className="fn-btnrow">
        <DisabledAction reason={BACKUP_NOW_UNAVAILABLE} label="Back up now">
          <span className="fn-btn fn-btn--brass">Back up now</span>
        </DisabledAction>
        <DisabledAction reason={RESTORE_UNAVAILABLE} label="Restore from a backup">
          <span className="fn-btn fn-btn--ghost">Restore…</span>
        </DisabledAction>
      </div>

      <p className="fn-consent">
        Restore is a consent moment (T2-2 pattern): it states what gets overwritten and demands the
        node name typed back. It is not offered here — a destructive confirmation that leads nowhere
        is worse than no button.
      </p>

      {notes ? (
        <p className="fn-note fn-note--dark">
          data — paths and sizes in mono; backup verification is a status word
        </p>
      ) : null}
    </section>
  );
}

function DataRow({ label, caption }: { label: string; caption: string }) {
  return (
    <>
      <dt className="fn-grid__key">{label}</dt>
      <dd className="fn-grid__val">
        <HollowInline caption={caption}>— not measured</HollowInline>
      </dd>
    </>
  );
}

// ===========================================================================

function NodeNotes() {
  return (
    <div className="fn-legend" data-testid="node-legend">
      <div className="fn-legend__item">
        <span className="fn-legend__bullet" aria-hidden>
          ◦
        </span>
        <p className="fn-legend__text">
          <strong>Node surfaces are graphite in both themes</strong> — like the registry (T2-2), the
          machine room reads terminal-adjacent, distinct from paper space-level settings.
        </p>
      </div>
      <div className="fn-legend__item">
        <span className="fn-legend__bullet" aria-hidden>
          ◦
        </span>
        <p className="fn-legend__text">
          <strong>Degraded propagates:</strong> the amber word here is the same reason the Run button
          carries in T0-3 and the palette shows in T1-2 — one truth, many surfaces. Here that truth
          is the seam’s connection state, computed nowhere else.
        </p>
      </div>
      <div className="fn-legend__item">
        <span className="fn-legend__bullet" aria-hidden>
          ◦
        </span>
        <p className="fn-legend__text">
          <strong>Slots are the cap made visible</strong> — in the design. In this build the cap has
          no reader, so the strip shows what is in use and says plainly that the ceiling is unknown.
        </p>
      </div>
    </div>
  );
}
