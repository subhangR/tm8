/**
 * SESSION SHARING — the two space defaults 187 added, written through
 * `spaces.update`.
 *
 * WHAT THIS SECTION IS NOT. It does not share anything that is running. Both
 * values are DEFAULTS a new session is stamped with at spawn; `w2_update_space`
 * never sweeps them over existing rows, so nobody's open terminal changes
 * posture because an admin clicked here. The copy says so in the section's
 * first sentence, before either control, because "sharing" read on its own
 * sounds like a switch on everything in the space — and a reader who believes
 * that will not go and set the one session they actually meant.
 *
 * ONE KEY PER WRITE. Each radio sends only its own key. `spaces.update` is a
 * PATCH whose absent keys are left alone, so changing who may type can never
 * reset who may watch — the same rule the per-session control keeps.
 *
 * AUTHORITY is `w2_update_space`'s (space admin). The client reads the viewer's
 * role only to say so BEFORE the click; a refusal that slips past it still
 * comes back in the server's own words beside the control it belongs to.
 */
import { useId, useState } from 'react';
import type { SpaceSummary, UpdateSpaceInput } from '@tm8/contract';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import { SHARING_DEFAULTS_NOT_ADMIN } from './reasons';
import './sharing-section.css';

type SharingPatch = Pick<UpdateSpaceInput, 'sessionShareDefault' | 'sessionDriveDefault'>;

export interface SharingSectionProps {
  space: SpaceSummary | null;
  /** Whether the viewer is an admin or owner here — decides the lock, not the write. */
  viewerIsAdmin: boolean;
  /** Absent ⇒ read-only (the board, or a host without the write wired). */
  onChange?: (patch: SharingPatch) => Promise<void>;
  heading?: string;
}

interface DialOption<V extends string> {
  value: V;
  label: string;
  hint: string;
}

const WATCH: readonly DialOption<'none' | 'space'>[] = [
  { value: 'space', label: 'Everyone in the space', hint: 'members can open the terminal and watch it' },
  { value: 'none', label: 'Only its owner', hint: 'nobody else sees the terminal' },
];

const TYPE: readonly DialOption<'owner' | 'space'>[] = [
  { value: 'owner', label: 'Only its owner', hint: 'others who can watch cannot type' },
  { value: 'space', label: 'Everyone who can watch', hint: 'watchers can also type into it' },
];

export function SharingSection({
  space,
  viewerIsAdmin,
  onChange,
  heading = 'Session sharing',
}: SharingSectionProps) {
  const [pending, setPending] = useState<keyof SharingPatch | null>(null);
  const [failure, setFailure] = useState<{ key: keyof SharingPatch; message: string } | null>(null);

  if (!space) {
    return (
      <SectionFrame title={heading} bodyTestId="sharing-body">
        <SectionAbsent
          testId="sharing-absent"
          head="The space has not been read."
          why="the space summary this section reads its defaults from did not load"
        />
      </SectionFrame>
    );
  }

  const share = space.sessionShareDefault;
  const drive = space.sessionDriveDefault;
  const locked = !onChange || !viewerIsAdmin;

  async function write<K extends keyof SharingPatch>(key: K, value: NonNullable<SharingPatch[K]>) {
    if (!onChange) return;
    setPending(key);
    setFailure(null);
    try {
      await onChange({ [key]: value } as SharingPatch);
    } catch (error) {
      setFailure({ key, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(null);
    }
  }

  return (
    <SectionFrame title={heading} bodyTestId="sharing-body">
      <div className="set-sharing">
        <p className="set-prose set-sharing__lead" data-testid="sharing-scope">
          <strong>Defaults for new sessions.</strong> A session started in this space from now
          on begins with these settings. Changing them does not touch any session that already
          exists — each one keeps its own, and its owner changes them from the session’s row.
        </p>

        {share === undefined && drive === undefined ? (
          <SectionAbsent
            testId="sharing-unreported"
            head="This node does not report sharing defaults."
            why="the space summary carries no sessionShareDefault or sessionDriveDefault — a node older than 187"
          />
        ) : (
          <>
            <Dial
              name="watch"
              legend="Who can watch a new session"
              options={WATCH}
              current={share}
              locked={locked}
              busy={pending === 'sessionShareDefault'}
              failure={failure?.key === 'sessionShareDefault' ? failure.message : null}
              onPick={(v) => void write('sessionShareDefault', v)}
            />
            <Dial
              name="type"
              legend="Who can type into it"
              options={TYPE}
              current={drive}
              locked={locked}
              busy={pending === 'sessionDriveDefault'}
              failure={failure?.key === 'sessionDriveDefault' ? failure.message : null}
              onPick={(v) => void write('sessionDriveDefault', v)}
              footnote="Typing needs watching: a session nobody else can watch is not typed into by anyone else either."
            />
            {locked ? (
              <p className="set-note set-sharing__lock" data-testid="sharing-lock">
                {SHARING_DEFAULTS_NOT_ADMIN.cause} — {SHARING_DEFAULTS_NOT_ADMIN.remedy}
              </p>
            ) : null}
            <p className="set-prose set-sharing__agents" data-testid="sharing-agents">
              <strong>Sessions a teammate launches</strong> are open to everyone in the space —
              to watch and to type — until someone sets that session’s sharing. From then on its
              settings apply to every member, including whoever launched it.
            </p>
          </>
        )}
      </div>
    </SectionFrame>
  );
}

function Dial<V extends string>({
  name,
  legend,
  options,
  current,
  locked,
  busy,
  failure,
  onPick,
  footnote,
}: {
  name: string;
  legend: string;
  options: readonly DialOption<V>[];
  current: V | undefined;
  locked: boolean;
  busy: boolean;
  failure: string | null;
  onPick: (value: V) => void;
  footnote?: string;
}) {
  const hintBase = useId();
  return (
    <fieldset className="set-sharing__dial" data-testid={`sharing-dial-${name}`} aria-busy={busy || undefined}>
      <legend className="set-eyebrow">{legend}</legend>
      <div className="set-sharing__opts" role="radiogroup" aria-label={legend}>
        {options.map((o) => {
          const on = current === o.value;
          const hintId = `${hintBase}-${o.value}`;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              className={`set-sharing__opt${on ? ' set-sharing__opt--on' : ''}`}
              disabled={locked || busy}
              data-value={o.value}
              aria-label={o.label}
              aria-describedby={hintId}
              onClick={() => {
                if (!on) onPick(o.value);
              }}
            >
              <span className="set-sharing__label">{o.label}</span>
              <span className="set-sharing__hint" id={hintId}>{o.hint}</span>
            </button>
          );
        })}
      </div>
      {current === undefined ? (
        <p className="set-note" data-testid={`sharing-${name}-unreported`}>
          this node did not report a value for this default
        </p>
      ) : null}
      {footnote ? <p className="set-note set-sharing__foot">{footnote}</p> : null}
      {failure ? (
        <p className="set-note set-sharing__fail" role="alert" data-testid={`sharing-${name}-failure`}>
          {failure}
        </p>
      ) : null}
    </fieldset>
  );
}
