import { useEffect, useRef, type ReactNode } from 'react';

import { STRIP_KIND, type StripKind } from './launch-strip';
import { aKind, kb, type InFullItem, type LaunchVerb } from './LaunchCardV3';

/**
 * THE TWO PREVIEWS the v3 card opens before it commits (mock rev 9): Launch
 * shows "What the agent gets", Dispatch shows "What the dispatcher gets".
 *
 * They describe what THIS NODE does today, not what the design will do once
 * the server catches up: memories still go in whole as `<memory>`; picked
 * references (files included) reach the prompt only as `<context_index>`
 * entries, and only while the context index is on. Where that differs from
 * the design, the section says so — a preview that described the target
 * design would be a promise the launch doesn't keep.
 */

export interface PreviewRow {
  id: string;
  kind: StripKind;
  title: string;
  /** The right-hand fact: a load command, a reason. */
  note?: string;
}

function Section({ head, hint, children, testId }: { head: string; hint?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="lcd3-sec" data-testid={testId}>
      <div className="lcd3-sec__h"><span>{head}</span>{hint ? <span className="lcd3-sec__hint">{hint}</span> : null}</div>
      <div className="lcd3-sec__b">{children}</div>
    </section>
  );
}

function Rows({ rows, empty }: { rows: readonly PreviewRow[]; empty: string }) {
  if (rows.length === 0) return <div className="lcd3-none">{empty}</div>;
  return (
    <>
      {rows.map((r) => (
        <div key={r.id} className="lcd3-prow">
          <span className="lcd-kind" aria-hidden="true">{STRIP_KIND[r.kind].glyph}</span>
          <span className="lcd3-prow__t">{r.title}</span>
          {r.note ? <code>{r.note}</code> : null}
        </div>
      ))}
    </>
  );
}

function Frame({ title, sub, children, confirm, onBack, onConfirm, busy, notice, testId }: {
  title: string;
  sub: ReactNode;
  children: ReactNode;
  confirm: string;
  onBack(): void;
  onConfirm(): void;
  busy: boolean;
  notice: string | null;
  testId: string;
}) {
  const go = useRef<HTMLButtonElement | null>(null);
  /* Focus lands on the commit button, so ⌘↵ / Enter / Space all confirm. */
  useEffect(() => { go.current?.focus({ preventScroll: true }); }, []);
  return (
    <div className="lcd3-preview" role="dialog" aria-modal="true" aria-label={title} data-testid={testId} data-focus-scope onClick={(event) => event.stopPropagation()}>
      <div className="lcd3-preview__card">
        <h2>{title}</h2>
        <div className="lcd3-preview__sub">{sub}</div>
        {children}
        {notice ? <p className="lcd3-preview__notice" role="alert">{notice}</p> : null}
        <div className="lcd3-preview__actions">
          <button type="button" className="lcd-btn" data-testid="lcd3-preview-back" onClick={onBack}>Back to the card</button>
          <button
            ref={go}
            type="button"
            className="lcd-btn lcd-btn--go"
            data-testid="lcd3-preview-confirm"
            aria-disabled={busy}
            onClick={() => { if (!busy) onConfirm(); }}
          >
            {busy ? `${confirm}…` : confirm} <span className="lcd-kbd" aria-hidden="true">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export interface AgentPreviewProps {
  verb: LaunchVerb;
  subjectTitle: string;
  continuing: boolean;
  runsAs: string;
  inFull: readonly InFullItem[];
  notes: string;
  memories: readonly PreviewRow[];
  skills: readonly PreviewRow[];
  /** Tasks, docs, artifacts, drawings — the context index's references. */
  references: readonly PreviewRow[];
  files: readonly PreviewRow[];
  leftOut: readonly PreviewRow[];
  /** Whether this node renders `<context_index>`; null: it didn't say. */
  contextIndex: 'on' | 'off' | null;
  onBack(): void;
  onConfirm(): void;
  busy: boolean;
  notice: string | null;
}

export function AgentPreview(p: AgentPreviewProps) {
  const refsReach = p.contextIndex === 'on';
  const indexHint = p.contextIndex === 'on'
    ? 'the context index is on'
    : p.contextIndex === 'off'
      ? 'the context index is OFF on this node — these are recorded but do not reach the prompt'
      : 'the node didn’t say whether the context index is on — these reach the prompt only if it is';
  return (
    <Frame
      title="What the agent gets"
      testId="lcd3-preview"
      confirm="Launch"
      sub={<>{cap(aKind(p.verb))} session{p.verb === 'coordinator' ? ' — spawns and directs its own workers' : p.verb === 'dispatcher' ? ' — routes work, never does it' : ''}. {p.runsAs}</>}
      onBack={p.onBack}
      onConfirm={p.onConfirm}
      busy={p.busy}
      notice={p.notice}
    >
      <Section head={p.continuing ? 'continues' : '<task> in full'} hint={p.continuing ? 'reads its transcript first' : 'the one task it works on'}>
        <div className="lcd3-prow"><span className="lcd-kind" aria-hidden="true">{p.continuing ? '◉' : '▣'}</span><span className="lcd3-prow__t">{p.subjectTitle}</span></div>
      </Section>
      <Section head="in full · read only" hint="no edges, no status change">
        <Rows rows={p.inFull.map((i) => ({ id: i.id, kind: (i.kind in STRIP_KIND ? i.kind : 'doc') as StripKind, title: i.title, ...(i.bytes !== null ? { note: kb(i.bytes) } : {}) }))} empty="Nothing else." />
      </Section>
      <Section head="your notes" hint="this launch only">
        {p.notes.trim() ? <div className="lcd3-pre">{p.notes}</div> : <div className="lcd3-none">None.</div>}
      </Section>
      <Section head="<memory>" hint="whole text — the node doesn’t index memories yet" testId="lcd3-preview-memories">
        <Rows rows={p.memories} empty="None." />
      </Section>
      <Section head="skills" hint="name, summary and a load command" testId="lcd3-preview-skills">
        <Rows rows={p.skills} empty="None." />
      </Section>
      <Section head="<context_index>" hint={indexHint} testId="lcd3-preview-index">
        <div data-reach={refsReach || undefined}>
          <Rows rows={p.references} empty="Empty." />
        </div>
      </Section>
      <Section head="files" hint="go in as context index entries today — <attachments> file references need the node change" testId="lcd3-preview-files">
        <Rows rows={p.files} empty="None." />
      </Section>
      {p.leftOut.length ? (
        <Section head="left out this launch" hint="unticked · never deleted from the task">
          <Rows rows={p.leftOut} empty="" />
        </Section>
      ) : null}
    </Frame>
  );
}

export interface DispatchPreviewProps {
  verb: LaunchVerb;
  subjectTitle: string;
  /** The dispatcher it goes to; null: the node uses its running one, or starts one. */
  target: { name: string; status: string } | null;
  /** The node doesn't report dispatchers, so which one answers is unknown. */
  targetUnknown: boolean;
  notes: string;
  inFullCount: number;
  onBack(): void;
  onConfirm(): void;
  busy: boolean;
  notice: string | null;
}

export function DispatchPreview(p: DispatchPreviewProps) {
  const to = p.target
    ? <>To <b>{p.target.name}</b> ({p.target.status}).</>
    : p.targetUnknown
      ? <>The node sends it to its running dispatcher, or starts one first.</>
      : <>No dispatcher is running — one is started first.</>;
  return (
    <Frame
      title="What the dispatcher gets"
      testId="lcd3-dispatch-preview"
      confirm="Dispatch"
      sub={<>{to} It chooses {aKind(p.verb)} — teammate, model, place and context — and spawns it. You see its choice on the task.</>}
      onBack={p.onBack}
      onConfirm={p.onConfirm}
      busy={p.busy}
      notice={p.notice}
    >
      <Section head="task" hint="the subject">
        <div className="lcd3-prow"><span className="lcd-kind" aria-hidden="true">▣</span><span className="lcd3-prow__t">{p.subjectTitle}</span><code>existing</code></div>
      </Section>
      <Section head="wants" hint="from the verb">
        <div className="lcd3-prow"><span className={`lcd3-verb lcd3-verb--${p.verb} lcd3-verb--sm`}>{p.verb.toUpperCase()}</span><span className="lcd3-prow__t">{aKind(p.verb)}</span></div>
      </Section>
      <Section head="note" hint="your text box, optional">
        {p.notes.trim() ? <div className="lcd3-pre">{p.notes}</div> : <div className="lcd3-none">None.</div>}
      </Section>
      <Section head="not sent" hint="the dispatcher decides these">
        <div className="lcd3-none">
          Teammate · project · model · effort · access · {p.inFullCount} in-full pick{p.inFullCount === 1 ? '' : 's'} · the strip’s context
        </div>
      </Section>
    </Frame>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
