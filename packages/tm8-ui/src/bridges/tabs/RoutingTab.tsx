import { useEffect, useState, type ReactNode } from 'react';
import { bridgeProviderLabel } from '../bridge-marks';
import type { BridgeHandleAppearance, BridgeView, EntitySummary } from '@tm8/contract';
import { BRIDGE_STYLE_MAX } from '@tm8/contract';
import { shortDate } from '../../kit/time';
import type { BridgePatch, BridgesPort } from '../api';
import { ConsequenceDialog } from '../ConsequenceDialog';
import { consequencesOf, retargetConsequences } from '../consequences';
import { TARGET_GLYPH, TARGET_WORD, bridgeFailureOf } from '../format';
import { unservedReason } from '../reasons';
import { draftOf, draftProblem, patchOf, type RoutingDraft } from '../routing-draft';

/**
 * ROUTING (§4.4, BRIDGES-V2-DESIGN §1.1, §1.2, §1.7): where the bridge lands
 * and how it behaves — every policy field a human can set has a labelled
 * control here, in plain words with an example where people get it wrong.
 *
 * One form, one Save: `bridges.update` with exactly the fields that changed.
 * A widening change (§1.5) shows its consequence and needs a second click; a
 * narrowing one saves at once and offers Undo, which is the same patch run
 * back. Retarget is its own human-only operation and always confirms.
 */
export function RoutingTab({
  view,
  port,
  onView,
  onOpenEntity,
}: {
  view: BridgeView;
  port: Pick<BridgesPort, 'update' | 'retarget' | 'targets' | 'handles' | 'serves'>;
  onView(next: BridgeView): void;
  onOpenEntity?: (id: string) => void;
}) {
  const [draft, setDraft] = useState<RoutingDraft>(() => draftOf(view));
  const [confirm, setConfirm] = useState<{ title: string; lines: string[]; label: string; run: () => Promise<void> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ text: string; undo: BridgePatch | null } | null>(null);
  const [busy, setBusy] = useState(false);
  /* A new version from elsewhere (the header's pause, another tab) resets the form to it. */
  useEffect(() => { setDraft(draftOf(view)); }, [view]);

  const ended = view.status === 'ended';
  const provider = bridgeProviderLabel(view.provider);
  const patch = patchOf(view, draft);
  const problem = draftProblem(draft);
  const set = (change: (d: RoutingDraft) => RoutingDraft) => { setDraft((d) => change(d)); setSaved(null); };
  const setPolicy = <K extends keyof RoutingDraft['policy']>(key: K, value: RoutingDraft['policy'][K]) =>
    set((d) => ({ ...d, policy: { ...d.policy, [key]: value } }));

  const apply = async (p: BridgePatch, undoable: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const next = await port.update(view.id, view.version, p);
      onView(next);
      setSaved({ text: 'Saved.', undo: undoable ? patchOf(next, draftOf(view)) : null });
    } catch (err) {
      setError(bridgeFailureOf(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    if (!patch || problem) return;
    const lines = consequencesOf(view, patch);
    if (lines.length === 0) { void apply(patch, true); return; }
    setConfirm({
      title: `Change how ${view.title} behaves?`, lines, label: 'Yes, change it',
      run: async () => { setConfirm(null); await apply(patch, false); },
    });
  };

  return (
    <div className="brg-routing" data-testid="bridge-routing">
      <TargetCard view={view} port={port} onView={onView} onOpenEntity={onOpenEntity} onConfirm={setConfirm} />

      <form
        className="brg-form"
        onSubmit={(event) => { event.preventDefault(); save(); }}
        aria-label={`${view.title} routing`}
      >
        <fieldset disabled={busy || ended} className="brg-form__fields">
          <Choice
            legend="When does tm8 answer?"
            name="trigger"
            value={draft.policy.trigger}
            onChange={(v) => setPolicy('trigger', v)}
            options={[
              ['mention', 'Only when someone writes @tm8 or replies to tm8'],
              ['every', 'Every message'],
              ['none', 'Never — log only'],
            ]}
          />
          <Choice
            legend={`What from tm8 goes back to ${provider}?`}
            name="outbound"
            value={draft.policy.outbound}
            onChange={(v) => setPolicy('outbound', v)}
            options={[
              ['replies', 'Only answers to the group', `e.g. tm8's reply to "@tm8 is the deploy done?"`],
              ['all', `Everything posted in ${view.target.title}`, 'e.g. also your own notes and agents\' updates there'],
            ]}
          />
          <Choice
            legend="Which way do messages flow?"
            name="direction"
            value={draft.policy.direction}
            onChange={(v) => setPolicy('direction', v)}
            options={[
              ['both', 'Both ways'],
              ['in', `${provider} → tm8 only`],
              ['out', `tm8 → ${provider} only`],
            ]}
          />
          <Choice
            legend="Who can start agents?"
            name="whoMayTrigger"
            value={draft.policy.whoMayTrigger}
            onChange={(v) => setPolicy('whoMayTrigger', v)}
            options={[
              ['linked', 'Linked people only'],
              ['anyone', 'Anyone in the group', 'asks first'],
            ]}
          />
          <Choice
            legend="How replies are signed"
            name="voice"
            value={draft.policy.voice}
            onChange={(v) => setPolicy('voice', v)}
            options={[
              ['named', '"tm8:" / "Release notes (keen-otter):"'],
              ['plain', 'No prefix'],
            ]}
          />
          <label className="brg-form__line">
            <span className="set-eyebrow">Style</span>
            <input
              type="text"
              value={draft.style}
              maxLength={BRIDGE_STYLE_MAX}
              placeholder="short and readable: lead with the answer…"
              onChange={(event) => set((d) => ({ ...d, style: event.target.value }))}
            />
            <span className="brg-muted">{draft.style.length}/{BRIDGE_STYLE_MAX}</span>
          </label>
          <label className="brg-form__line">
            <span className="set-eyebrow">What the group is for</span>
            <input
              type="text"
              value={draft.purpose}
              placeholder="Deploys, incidents and the on-call rota"
              onChange={(event) => set((d) => ({ ...d, purpose: event.target.value }))}
            />
          </label>
          <div className="brg-form__line">
            <label>
              <input
                type="checkbox"
                checked={draft.quiet.on}
                onChange={(event) => set((d) => ({ ...d, quiet: { ...d.quiet, on: event.target.checked } }))}
              />
              {' '}Quiet hours: hold unprompted posts
            </label>
            {draft.quiet.on ? (
              <span className="brg-form__times">
                from <input type="time" aria-label="Quiet from" value={draft.quiet.start} onChange={(event) => set((d) => ({ ...d, quiet: { ...d.quiet, start: event.target.value } }))} />
                to <input type="time" aria-label="Quiet until" value={draft.quiet.end} onChange={(event) => set((d) => ({ ...d, quiet: { ...d.quiet, end: event.target.value } }))} />
              </span>
            ) : null}
          </div>

          <Group title="History & retention">
            <Choice
              legend="Keep messages"
              name="retention"
              value={draft.retention.forever ? 'forever' : 'days'}
              onChange={(v) => set((d) => ({ ...d, retention: { ...d.retention, forever: v === 'forever' } }))}
              options={[
                ['forever', 'Forever'],
                ['days', 'For a number of days, then delete them here', `${provider} keeps its own copy`],
              ]}
            />
            {!draft.retention.forever ? (
              <label className="brg-form__line">
                <span>Days</span>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  aria-label="Keep messages for days"
                  value={draft.retention.days}
                  onChange={(event) => set((d) => ({ ...d, retention: { ...d.retention, days: Number(event.target.value) } }))}
                />
              </label>
            ) : null}
            <p className="brg-hint">
              Applies to messages, voice transcripts and media from this group. Tasks, docs and memories made from
              them are not deleted.
            </p>
            <div className="brg-form__line">
              <button type="button" className="pn-btn" disabled title={unservedReason(port, 'bridges.history.import', 'Importing earlier messages') ?? undefined}>
                Import earlier messages
              </button>
              <span className="brg-hint">{unservedReason(port, 'bridges.history.import', 'Importing earlier messages')}</span>
            </div>
          </Group>

          <Group title="Workers">
            <label className="brg-form__line">
              <input
                type="checkbox"
                checked={draft.workerPosting}
                onChange={(event) => set((d) => ({ ...d, workerPosting: event.target.checked }))}
              />
              {' '}Workers in this space may post here, signed with their handle
            </label>
            <Choice
              legend="The most a worker may listen to"
              name="workerWake"
              value={draft.workerWake}
              onChange={(v) => set((d) => ({ ...d, workerWake: v }))}
              options={[
                ['directed', 'Only messages addressed to it (@handle)'],
                ['thread', 'Also replies in threads it is in'],
                ['all', 'Every message', 'asks first'],
              ]}
            />
          </Group>

          <Group title="Commands">
            <p className="brg-hint">
              Which slash commands each person may run here arrives with the command layer (BRIDGES-V2-DESIGN §4.6).
            </p>
          </Group>
        </fieldset>
        <div className="brg-form__save">
          {problem ? <span className="brg-error" role="alert">{problem}</span> : null}
          {error ? <span className="brg-error" role="alert">{error}</span> : null}
          {saved ? (
            <span className="brg-hint" role="status">
              {saved.text}{' '}
              {saved.undo ? (
                <button type="button" className="brg-link" onClick={() => { const undo = saved.undo!; setSaved(null); void apply(undo, false); }}>
                  Undo
                </button>
              ) : null}
            </span>
          ) : null}
          <button type="button" className="pn-btn" disabled={!patch || busy} onClick={() => { setDraft(draftOf(view)); setSaved(null); }}>
            Discard
          </button>
          <button type="submit" className="pn-btn pn-btn--primary" disabled={!patch || problem !== null || busy || ended}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </form>

      <Handles view={view} port={port} onOpenEntity={onOpenEntity} />

      {confirm ? (
        <ConsequenceDialog
          title={confirm.title}
          consequences={confirm.lines}
          confirmLabel={confirm.label}
          onCancel={() => setConfirm(null)}
          onConfirm={confirm.run}
        />
      ) : null}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="brg-group" aria-label={title}>
      <h3 className="set-eyebrow brg-subhead">{title}</h3>
      {children}
    </section>
  );
}

function Choice<V extends string>({
  legend,
  name,
  value,
  onChange,
  options,
}: {
  legend: string;
  name: string;
  value: V;
  onChange(value: V): void;
  options: readonly (readonly [V, string, string?])[];
}) {
  return (
    <fieldset className="brg-choice">
      <legend className="set-eyebrow">{legend}</legend>
      {options.map(([v, label, aside]) => (
        <label key={v} className="brg-choice__opt">
          <input type="radio" name={name} value={v} checked={value === v} onChange={() => onChange(v)} />
          <span>{label}</span>
          {aside ? <span className="brg-muted">{aside}</span> : null}
        </label>
      ))}
    </fieldset>
  );
}

function TargetCard({
  view,
  port,
  onView,
  onOpenEntity,
  onConfirm,
}: {
  view: BridgeView;
  port: Pick<BridgesPort, 'retarget' | 'targets'>;
  onView(next: BridgeView): void;
  onOpenEntity?: (id: string) => void;
  onConfirm(c: { title: string; lines: string[]; label: string; run: () => Promise<void> }): void;
}) {
  const [targets, setTargets] = useState<EntitySummary[] | null>(null);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    let live = true;
    void port.targets(view.spaceId).then((t) => { if (live) setTargets(t); }, () => { if (live) setTargets([]); });
    return () => { live = false; };
  }, [port, view.spaceId]);

  const others = (targets ?? []).filter((t) => t.id !== view.target.id);
  const chosen = others.find((t) => t.id === pick) ?? null;
  const move = () => {
    if (!chosen) return;
    onConfirm({
      title: `Move ${view.title} to ${chosen.title}?`,
      lines: retargetConsequences(view, { title: chosen.title, kind: chosen.kind }),
      label: 'Move it',
      run: async () => {
        setMoving(true);
        setError(null);
        try {
          onView(await port.retarget(view.id, view.version, chosen.id));
          setPick('');
        } catch (err) {
          setError(bridgeFailureOf(err));
        } finally {
          setMoving(false);
        }
      },
    });
  };

  return (
    <section className="brg-target" aria-label="Lands in" data-testid="bridge-target">
      <span className="set-eyebrow">Lands in</span>
      <div className="brg-target__card">
        <span aria-hidden="true" className="brg-target__glyph">{TARGET_GLYPH[view.target.kind]}</span>
        {onOpenEntity ? (
          <button type="button" className="brg-link" onClick={() => onOpenEntity(view.target.id)}>{view.target.title}</button>
        ) : <strong>{view.target.title}</strong>}
        <span className="brg-muted">{TARGET_WORD[view.target.kind]}</span>
      </div>
      <div className="brg-target__move">
        <select
          aria-label="Move to"
          value={pick}
          onChange={(event) => setPick(event.target.value)}
          disabled={moving || view.status === 'ended' || targets === null}
        >
          <option value="">{targets === null ? 'Loading targets…' : 'Move to another chat, session or channel…'}</option>
          {others.map((t) => (
            <option key={t.id} value={t.id}>{TARGET_GLYPH[t.kind as keyof typeof TARGET_GLYPH] ?? ''} {t.title}</option>
          ))}
        </select>
        <button type="button" className="pn-btn" disabled={!chosen || moving} onClick={move}>
          {moving ? 'Moving…' : 'Move'}
        </button>
      </div>
      {error ? <p className="brg-error" role="alert">{error}</p> : null}
    </section>
  );
}

function Handles({
  view,
  port,
  onOpenEntity,
}: {
  view: BridgeView;
  port: Pick<BridgesPort, 'handles'>;
  onOpenEntity?: (id: string) => void;
}) {
  const [rows, setRows] = useState<BridgeHandleAppearance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void port.handles(view.id).then((r) => { if (live) setRows(r); }, (err) => { if (live) setError(bridgeFailureOf(err)); });
    return () => { live = false; };
  }, [port, view.id, view.version]);
  return (
    <section className="brg-group" aria-label="Handles" data-testid="bridge-handles">
      <h3 className="set-eyebrow brg-subhead">Handles</h3>
      <p className="brg-hint">The sessions and chats that have spoken here, by the handle the group sees (D23).</p>
      {error ? <p className="brg-error" role="alert">{error}</p> : rows === null ? (
        <p className="brg-hint" role="status">Loading handles…</p>
      ) : rows.length === 0 ? (
        <p className="brg-hint">No handle has appeared on this bridge yet.</p>
      ) : (
        <table className="brg-table">
          <thead><tr><th scope="col">Handle</th><th scope="col">Title</th><th scope="col">Is</th><th scope="col">State</th><th scope="col">Last</th></tr></thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.handle}>
                <td className="brg-mono">{h.handle}</td>
                <td>{h.title ?? '—'}</td>
                <td>
                  {onOpenEntity ? (
                    <button type="button" className="brg-link" onClick={() => onOpenEntity(h.entityId)}>
                      {h.kind === 'chat' ? '💬 chat' : '▶ session'}
                    </button>
                  ) : h.kind === 'chat' ? 'chat' : 'session'}
                </td>
                <td>{h.status}</td>
                <td>{shortDate(h.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
