import { useMemo } from 'react';
import type { EntityDetail } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import { Eyebrow, Pill, VectorIcon } from '../../kit';
import type { PillTone } from '../../kit';
import { SURFACE_ART, SURFACE_LABEL, getKind } from '../../domain';
import type { ContentSurface } from '../../routes/types';
import { HollowInline } from '../honesty/HollowValue';
import './machine-body.css';

/**
 * THE MACHINE ARCHETYPE BODY — a container's panel (Design §13.2).
 *
 * A NEW ARCHETYPE, NOT A SPECIAL CASE OF `terminal`, and the distinction is
 * structural rather than stylistic. The terminal archetype is a SESSION: one
 * live PTY canvas with transcript/git/debug/graph beside it, and
 * `WorkSessionContent` owning the switch. This is the HOST a session may run
 * inside — nine lifecycle states a session does not have, surfaces a session
 * does not have, and a lifetime that outlives every session bound to it.
 * Folding the two together would put a kind branch inside
 * `WorkSessionContent`, which is the thing §15.2 exists to prevent.
 *
 * ARCHETYPE, NOT KIND. Nothing here names a kind — `panels/no-branching.test.ts`
 * fails the build on the literal. The status vocabulary, the tone map and the
 * refusal sentences all arrive as REGISTRY DATA through `getKind(detail.kind)`,
 * so a second machine-shaped kind is a registry row and not an edit here.
 *
 * WHAT P0 DRAWS, and what it deliberately does not:
 *
 *   · the STATUS, from the entity, tinted by the registry's tone map;
 *   · the LIVE dot, from `seam.liveness.statusOf` and from nowhere else;
 *   · the SPEC summary — what the machine is and what it was given;
 *   · a SURFACE RAIL that is entirely refusals in P0.
 *
 * The surfaces themselves are later phases (terminal P1, screen P2). The rail
 * ships now, refusing by name, because a surface that is COMING must be
 * visible and refused rather than missing — DEF-003, in `WorkSessionContent`'s
 * words: "a surface removed without a word is a surface nobody can report
 * missing." It also gives those lanes a landing site that already has its
 * arrangement, its labels and its tests.
 *
 * THE TWO-SOURCE LAW (R-UI-5), which this body is a consumer of. The STATUS
 * PILL and the capability booleans come from the ENTITY. The LIVE dot comes
 * from the liveness VERDICT. They are different questions — "what does the
 * graph record" versus "is anything answering right now" — and a container
 * stays `running` in the graph for exactly as long as nobody has told the
 * graph otherwise, which is the ghost case. With no verdict in hand this draws
 * LIVENESS UNVERIFIED and never claims the machine is up.
 *
 * NO px FLOOR ANYWHERE IN THIS BODY, and that is a fix carried forward rather
 * than an omission. The artifact panel is the other `composition: 'frame'`
 * kind, and it shipped a section with `min-height: 0` above a child holding a
 * 420px floor: on a short panel the frame PAINTED STRAIGHT OVER THE BLOCK
 * BELOW IT. Nothing here reserves a height it cannot give back, so a short
 * panel scrolls. When the screen surface lands it must take the same care —
 * see `machine-body.css`, which says so at the seam it would break.
 */

/** The surfaces a machine offers, in the order the rail draws them (§13.2). */
const MACHINE_SURFACES: readonly ContentSurface[] = ['screen', 'terminal', 'logs'];

/**
 * WHY EACH SURFACE IS REFUSED IN P0 — one sentence each, never a blanket one.
 *
 * A refusal that does not say WHY is a shrug (the `PHONE_REFUSED` precedent).
 * Each of these names the MECHANISM and the phase, so a reader can tell "not
 * built yet" from "not possible here" — two very different pieces of news.
 *
 * A surface REMOVED from this map is a surface claiming to work. That is the
 * edit the P1/P2 lanes make, and it is one line each.
 */
const SURFACE_UNBUILT: Readonly<Partial<Record<ContentSurface, string>>> = {
  screen: 'The screen surface isn’t built yet. It needs a grant from containers.attach and an RFB client, and neither has landed — so there is nothing to show rather than nothing to see.',
  terminal: 'The exec terminal isn’t mounted in this panel yet. The door is live: “Terminal” on the panel bar starts a real exec session and opens it, which is the same PTY this surface will host.',
  logs: 'Log streaming isn’t implemented on this node yet — containers.logs answers 501 with a named reason, so this surface would have nothing to poll.',
};

export interface MachineBodyProps {
  detail: EntityDetail;
  /**
   * The seam's liveness verdict for this container — `seam.liveness.statusOf`,
   * NEVER read off `detail.content` (R-UI-5). Absent means UNVERIFIED, which
   * is a third answer and not a quiet `not-running`.
   */
  liveness?: SessionLiveness;
}

/** A `ContainerSpec` read structurally — never by comparing `kind` (§15.2). */
interface SpecView {
  image?: unknown;
  spec?: {
    cpus?: unknown;
    memMiB?: unknown;
    diskMiB?: unknown;
    mounts?: unknown;
    ports?: unknown;
    env?: unknown;
    network?: { preset?: unknown; allow?: unknown };
  };
  lifecycle?: { ephemeral?: unknown; ttlSeconds?: unknown; graceSeconds?: unknown };
  surfaceDetail?: Record<string, { live?: unknown } | undefined>;
  usage?: { cpuPct?: unknown; memMiB?: unknown } | null;
  error?: unknown;
  exposed?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** MiB → the largest honest unit. 4096 reads as 4 GiB, 812 stays 812 MiB. */
function mib(value: unknown): string | null {
  const n = num(value);
  if (n === null) return null;
  return n >= 1024 ? `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} GiB` : `${n} MiB`;
}

export function MachineBody({ detail, liveness }: MachineBodyProps) {
  const config = getKind(detail.kind);
  const content = detail.content as unknown as SpecView;
  const state = detail.state as unknown as Record<string, unknown>;

  const status = str(state.status);
  const pill = config.panel.statusPill;
  /* REGISTRY DATA, not a local table. The tone for `failed` is declared once,
     on the row, and the chip on the tile reads the same map — so the list and
     the panel cannot disagree about what a status looks like. */
  const tone: PillTone = (status && pill?.tones[status]) || 'idle';

  /*
   * THE LIVE DOT — three states, and `unverified` is a real one.
   *
   * `SessionLiveness` is the seam's verdict vocabulary and it is shared: a
   * container's runtime is probed the same way a session's PTY is. Absent
   * means nobody measured, which must never render as "not running" — that
   * would be this panel asserting a measurement it did not take.
   */
  const livenessWord =
    liveness === undefined || liveness === 'unknown'
      ? null
      : liveness === 'live'
        ? 'live'
        : liveness;

  const rows = useMemo(() => {
    const spec = content.spec ?? {};
    const cpus = num(spec.cpus);
    const mounts = Array.isArray(spec.mounts) ? spec.mounts : [];
    const ports = Array.isArray(spec.ports) ? spec.ports : [];
    const envKeys = spec.env && typeof spec.env === 'object' ? Object.keys(spec.env as object) : [];
    const allow = Array.isArray(spec.network?.allow) ? (spec.network?.allow as unknown[]) : [];
    return [
      { label: 'Image', value: str(content.image) },
      { label: 'Profile', value: str(state.profile) },
      { label: 'Provider', value: str(state.provider) },
      { label: 'Isolation', value: str(state.isolation) },
      { label: 'Node', value: str(state.nodeId) },
      { label: 'CPU', value: cpus === null ? null : `${cpus} vCPU` },
      { label: 'Memory', value: mib(spec.memMiB) },
      { label: 'Disk', value: mib(spec.diskMiB) },
      /* Mounts render `guest` and `ro` and NOTHING ELSE. Ruling R5: the read
         side of `ContainerMount` carries no host path — it is split from
         `ContainerMountInput` precisely so a host path cannot be read back —
         so there is no row here that could show one. */
      {
        label: 'Mounts',
        value: mounts.length === 0
          ? null
          : mounts
            .map((m) => {
              const guest = str((m as { guest?: unknown }).guest);
              return guest === null ? null : `${guest}${(m as { ro?: unknown }).ro === true ? ' (ro)' : ''}`;
            })
            .filter((m): m is string => m !== null)
            .join(' · '),
      },
      { label: 'Ports', value: ports.length === 0 ? null : ports.join(', ') },
      { label: 'Network', value: str(spec.network?.preset) },
      { label: 'Allowed', value: allow.length === 0 ? null : `${allow.length} host${allow.length === 1 ? '' : 's'}` },
      /* KEYS, NEVER VALUES. The contract refuses secret-looking env KEYS at
         the door, but an ordinary key can still hold something private, and a
         panel is a screen someone else can be standing behind. */
      { label: 'Env', value: envKeys.length === 0 ? null : `${envKeys.length} variable${envKeys.length === 1 ? '' : 's'}` },
      { label: 'Lifetime', value: content.lifecycle?.ephemeral === true ? 'ephemeral' : content.lifecycle?.ephemeral === false ? 'persistent' : null },
      { label: 'TTL', value: num(content.lifecycle?.ttlSeconds) === null ? null : `${num(content.lifecycle?.ttlSeconds)}s` },
    ];
  }, [content, state]);

  const usage = content.usage ?? null;
  const error = str(content.error);

  return (
    <div className="pn-machine" data-testid="machine-body">
      <div className="pn-machine__head">
        <Pill tone={tone}>{status ?? 'unknown'}</Pill>
        {/*
          * THE DOT IS A SEPARATE READING FROM THE PILL and is drawn as one.
          * Same row so they can be compared at a glance, different sources so
          * they can disagree — which is the whole point: a `running` pill
          * beside an UNVERIFIED dot is the ghost, stated rather than hidden.
          */}
        {livenessWord === null ? (
          <span className="pn-machine__liveness pn-machine__liveness--unverified" data-testid="machine-liveness">
            liveness unverified
          </span>
        ) : (
          <span
            className={`pn-machine__liveness pn-machine__liveness--${livenessWord === 'live' ? 'live' : 'off'}`}
            data-testid="machine-liveness"
          >
            <span className="pn-machine__dot" aria-hidden="true" />
            {livenessWord}
          </span>
        )}
        {usage ? (
          <span className="pn-machine__usage" data-testid="machine-usage">
            {num(usage.cpuPct) ?? 0}% cpu · {mib(usage.memMiB) ?? '—'}
          </span>
        ) : null}
      </div>

      {/*
        * THE FAILURE REASON, VERBATIM. `failed` is one of the nine, and a
        * status word with no cause is the thing a reader cannot act on. The
        * node's own sentence, never paraphrased into a generic failure.
        */}
      {error ? (
        <p className="pn-machine__error" role="alert" data-testid="machine-error">
          {error}
        </p>
      ) : null}

      <section className="pn-machine__spec" aria-label="Specification">
        <Eyebrow>MACHINE</Eyebrow>
        <dl className="pn-machine__rows">
          {rows.map((row) => (
            <div className="pn-machine__row" key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value === null ? <HollowInline caption="The node has not recorded this for the container." /> : row.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="pn-machine__surfaces" aria-label="Surfaces">
        <Eyebrow>SURFACES</Eyebrow>
        <ul className="pn-machine__rail">
          {MACHINE_SURFACES.map((surface) => {
            const unbuilt = SURFACE_UNBUILT[surface];
            /*
             * `surfaceDetail` IS A PARTIAL RECORD — every key may be absent,
             * `screen` included. Reading `.screen.live` without this guard is
             * the crash lane B flagged, and the fixtures omit `screen` on
             * every row precisely so it happens here, in jsdom, if anyone
             * removes the guard.
             */
            const announced = content.surfaceDetail?.[surface];
            const live = announced?.live === true;
            return (
              <li className="pn-machine__surface" key={surface} data-surface={surface}>
                <span className="pn-machine__surface-name">
                  <VectorIcon paths={SURFACE_ART[surface]} size={14} />
                  {SURFACE_LABEL[surface]}
                </span>
                <span className="pn-machine__surface-state">
                  {live ? 'announced by the node' : 'not announced'}
                </span>
                {unbuilt ? (
                  <p className="pn-machine__surface-refusal">{unbuilt}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
