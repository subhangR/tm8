/**
 * "Add anything": type it, pick what it becomes, where it goes, who runs it
 * and who gets told — and read, in plain words, what submitting will do.
 * One submit is one `StoryAddRequest` to `actions.add`.
 */
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TeamMemberMode } from '@tm8/contract';

import { Avatar } from '../../kit/Avatar';
import { Kbd } from '../../kit/Kbd';
import { KindIcon } from '../../domain/KindIcon';
import type { StoryAddRequest, StoryIntent } from '../actions';
import { MODE_WORD, STORY_KIND, type StoryView } from '../model';
import {
  INTENT,
  INTENTS,
  NEW_MODES,
  asOptions,
  defaultTell,
  onOptions,
  previewSentence,
  tellOptions,
} from './intents';
import { isSubmitKey, useFocusTrap } from './keys';
import { useSubmit } from './useSubmit';

/** What the sheet opens with (the plus, ⌘K, or a popover handing over). */
export interface SheetDraft {
  intent: StoryIntent;
  text?: string;
  onId?: string | null;
  asTeammateId?: string | null;
}

/** The "as" pick that means "a new teammate". */
const NEW = '';

export function AddSheet({
  view,
  add,
  draft,
  onClose,
}: {
  view: StoryView;
  add: (req: StoryAddRequest) => Promise<string | void>;
  draft: SheetDraft;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();

  const ons = useMemo(() => onOptions(view, draft.onId), [view, draft.onId]);
  const ases = useMemo(() => asOptions(view), [view]);
  const tells = useMemo(() => tellOptions(view), [view]);

  const [intent, setIntent] = useState<StoryIntent>(draft.intent);
  const [text, setText] = useState(draft.text ?? '');
  const [onId, setOnId] = useState<string>(draft.onId && ons.some((o) => o.id === draft.onId) ? draft.onId : view.id);
  const [asId, setAsId] = useState<string>(draft.asTeammateId ?? ases[0]?.id ?? NEW);
  const [mode, setMode] = useState<TeamMemberMode | null>(null);
  const [told, setTold] = useState<ReadonlySet<string>>(() => new Set(defaultTell(view)));

  const spec = INTENT[intent];
  const newMode = mode ?? spec.newMode;
  const asPick = ases.find((a) => a.id === asId);
  const { status, error, run, busy } = useSubmit(onClose);
  const onKeyDown = useFocusTrap(box, onClose);

  useLayoutEffect(() => {
    const t = textRef.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);

  const toggleTell = (id: string) =>
    setTold((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const submit = () => {
    if (busy || !text.trim()) return;
    const req: StoryAddRequest = {
      intent,
      text: text.trim(),
      onId: spec.needsOn ? onId : view.id,
      tellIds: [...told],
    };
    if (spec.needsAs) {
      req.asTeammateId = asPick ? asPick.id : null;
      req.mode = asPick ? null : newMode;
    }
    void run(() => add(req));
  };

  const preview = previewSentence(view, {
    intent,
    text,
    on: ons.find((o) => o.id === onId),
    as: spec.needsAs
      ? asPick
        ? { name: asPick.name, modeWord: asPick.modeWord, isNew: false }
        : { name: '', modeWord: MODE_WORD[newMode], isNew: true }
      : null,
    told: tells.filter((t) => told.has(t.id)).map((t) => t.name),
  });

  return (
    <div
      ref={box}
      className="sp-sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(ev) => {
        if (isSubmitKey(ev, ev.target === textRef.current)) {
          ev.preventDefault();
          submit();
          return;
        }
        onKeyDown(ev);
      }}
    >
      <div className="sp-sheet__head">
        <span className="t-eyebrow" id={titleId}>
          Add anything
        </span>
        <span className="sp-sheet__sub">type it · pick what it becomes · say who gets told</span>
        <button type="button" className="sp-x" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="sp-sheet__in">
        <KindIcon kind={STORY_KIND} size={18} className="sp-sheet__glyph" />
        <textarea
          ref={textRef}
          rows={2}
          value={text}
          placeholder="What should happen? Write it the way you would say it…"
          aria-label="What to add"
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
        />
      </div>

      <Row label="becomes">
        {INTENTS.map((s) => (
          <Opt key={s.intent} on={s.intent === intent} onClick={() => setIntent(s.intent)}>
            <KindIcon kind={s.glyph} size={13} />
            {s.label}
          </Opt>
        ))}
      </Row>

      {spec.needsOn && (
        <Row label="on">
          {ons.map((o) => (
            <Opt key={o.id} on={o.id === onId} onClick={() => setOnId(o.id)}>
              <KindIcon kind={o.glyph} size={13} />
              {o.label}
            </Opt>
          ))}
        </Row>
      )}

      {spec.needsAs && (
        <Row label="as">
          {ases.map((a) => (
            <Opt key={a.id} on={a.id === asId} onClick={() => setAsId(a.id)}>
              <Avatar actorId={a.id} provenance="agent" label={a.name} initials={a.initials} size={15} />
              {a.name}
              <span className="sp-opt__m">{a.modeWord}</span>
            </Opt>
          ))}
          <Opt on={!asPick} onClick={() => setAsId(NEW)}>
            ＋ a new teammate
          </Opt>
        </Row>
      )}

      {spec.needsAs && !asPick && (
        <Row label="mode">
          {NEW_MODES.map((m) => (
            <Opt key={m} on={m === newMode} onClick={() => setMode(m)}>
              {MODE_WORD[m]}
            </Opt>
          ))}
        </Row>
      )}

      {tells.length > 0 && (
        <Row label="tell">
          {tells.map((t) => (
            <Opt key={t.id} on={told.has(t.id)} onClick={() => toggleTell(t.id)}>
              <Avatar
                actorId={t.id}
                provenance={t.agent ? 'agent' : 'human'}
                label={t.name}
                initials={t.initials}
                size={15}
              />
              {t.name}
              <span className="sp-opt__m">{t.note}</span>
            </Opt>
          ))}
        </Row>
      )}

      <div className="sp-preview" aria-live="polite">
        {preview}
      </div>

      <div className="sp-sheet__foot">
        <span className={status === 'error' ? 'sp-hint sp-hint--error' : 'sp-hint'} role={status === 'error' ? 'alert' : undefined}>
          {status === 'pending'
            ? 'Adding…'
            : status === 'done'
              ? 'Done — the story updates from this.'
              : status === 'error'
                ? error
                : 'The story itself updates from this: progress, the graph, what’s happening.'}
        </span>
        {spec.alt && (
          <button type="button" className="pn-btn" disabled={busy} onClick={() => setIntent(spec.alt!.to)}>
            {spec.alt.label}
          </button>
        )}
        <button type="button" className="pn-btn pn-btn--primary" disabled={busy || !text.trim()} onClick={submit}>
          {status === 'pending' ? 'Adding…' : status === 'done' ? 'Added' : spec.go}
        </button>
        <span className="sp-keys" aria-hidden="true">
          <Kbd>↵</Kbd>
        </span>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sp-row" role="group" aria-label={label}>
      <span className="sp-row__lbl">{label}</span>
      {children}
    </div>
  );
}

export function Opt({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={on ? 'sp-opt sp-opt--on' : 'sp-opt'} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}
