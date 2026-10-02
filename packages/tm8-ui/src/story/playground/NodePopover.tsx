/**
 * Click any node: talk to it. A popover anchored to the clicked element with
 * the verbs that make sense for that node AND have an action behind them —
 * message it, new task under, spawn here, dispatch here, mark done.
 *
 * Message, new task and mark done act right here. Spawn and dispatch need a
 * runner and a "tell", so they hand the text over to the Add anything sheet
 * with this node as its target.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { KindIcon } from '../../domain/KindIcon';
import type { StoryActions } from '../actions';
import { MODE_WORD, SESSION_KIND, STORY_KIND, TASK_KIND, TEAMMATE_KIND, liveOn, nameOf, type StoryView } from '../model';
import type { StoryNodePick } from '../props';
import { Opt, type SheetDraft } from './AddSheet';
import { TASK_INTENT } from './intents';
import { isSubmitKey, useFocusTrap } from './keys';
import { useSubmit } from './useSubmit';

type Verb = 'say' | 'child' | 'spawn' | 'dispatch' | 'close';

const WIDTH = 360;
const GAP = 14;
const MARGIN = 8;
/** A conservative height for keeping the box on screen before it has measured. */
const EST_HEIGHT = 220;

interface Target {
  id: string;
  kind: string;
  title: string;
  /** The mono tag beside the title ("task", "W·Kilo"). */
  tag: string;
  /** The footer's line: what a message here does. */
  sub: string;
  /** Where a message goes: the live session on it, else the node itself. */
  messageAnchor: string;
  messageLabel: string;
  /** Can hold children / run work (a task, the story, a live session). */
  workable: boolean;
  /** A task that is not finished. */
  closable: boolean;
  /** A teammate node: spawn runs AS it rather than on it. */
  teammateId: string | null;
}

function targetOf(view: StoryView, id: string): Target | null {
  const live = liveOn(view);
  if (id === view.id) {
    return { id, kind: STORY_KIND, title: view.title, tag: 'story', sub: 'story · a message here goes on the story thread', messageAnchor: id, messageLabel: 'Message the story', workable: true, closable: false, teammateId: null };
  }
  const session = view.page.sessions.find((s) => s.id === id);
  const teammate = view.page.team.find((t) => t.id === id);
  const node = view.page.nodes.find((n) => n.id === id);
  if (session) {
    const who = nameOf(view, session.teamMemberId);
    const mode = session.mode ? MODE_WORD[session.mode] : 'session';
    return {
      id,
      kind: node?.kind ?? SESSION_KIND,
      title: node?.title ?? session.title,
      tag: session.callSign,
      sub: session.live
        ? `${session.callSign} · ${who} · ${mode} · live · the message reaches the session this turn`
        : `session · exited · the message waits for a resume`,
      messageAnchor: id,
      messageLabel: `Message ${session.callSign}`,
      workable: session.live,
      closable: false,
      teammateId: null,
    };
  }
  if (teammate) {
    return {
      id,
      kind: TEAMMATE_KIND,
      title: teammate.name,
      tag: teammate.kind === 'member' ? 'member' : teammate.mode ? MODE_WORD[teammate.mode] : 'teammate',
      sub: teammate.kind === 'member' ? 'member · a message here reaches them' : 'teammate · spawn runs a new session as it',
      messageAnchor: id,
      messageLabel: `Message ${teammate.name}`,
      workable: false,
      closable: false,
      // A dispatcher routes work rather than running it, and a human member
      // never runs a launch: no "spawn as" for either.
      teammateId: teammate.mode === 'dispatcher' || teammate.kind === 'member' ? null : id,
    };
  }
  if (!node) return null;
  const isTask = node.kind === TASK_KIND;
  const s = live.get(id);
  const who = s ? nameOf(view, s.teamMemberId) : null;
  return {
    id,
    kind: node.kind,
    title: node.title,
    tag: s ? s.callSign : node.status ?? node.kind,
    sub: s
      ? `${s.callSign} · ${who} · ${s.mode ? MODE_WORD[s.mode] : 'session'} · live · the message reaches the session this turn`
      : 'a message here is on its anchor',
    messageAnchor: s ? s.id : id,
    messageLabel: s ? `Message ${s.callSign}` : 'Message here',
    workable: isTask || !!s,
    closable: isTask && node.statusCategory !== 'done' && node.statusCategory !== 'cancelled',
    teammateId: null,
  };
}

const PLACEHOLDER: Record<Verb, string> = {
  say: 'Say something on this anchor…',
  child: 'Title of the new task…',
  spawn: 'The brief for the new session…',
  dispatch: 'The task to hand out…',
  close: 'A closing note (optional)…',
};

const GO: Record<Verb, string> = {
  say: 'Send',
  child: 'Add',
  spawn: 'Spawn…',
  dispatch: 'Dispatch…',
  close: 'Complete',
};

export function NodePopover({
  view,
  actions,
  pick,
  onClose,
  onHandOver,
}: {
  view: StoryView;
  actions: StoryActions;
  pick: StoryNodePick;
  onClose: () => void;
  /** Open the sheet with this draft (spawn / dispatch need its rows). */
  onHandOver: ((draft: SheetDraft) => void) | null;
}) {
  const target = useMemo(() => targetOf(view, pick.entityId), [view, pick.entityId]);
  const verbs = useMemo(() => {
    if (!target) return [];
    const out: { verb: Verb; label: string }[] = [];
    if (actions.sendMessage) out.push({ verb: 'say', label: target.messageLabel });
    if (target.workable && (actions.add || (actions.createTask && target.id !== view.id))) out.push({ verb: 'child', label: 'New task under' });
    if (onHandOver && (target.workable || target.teammateId)) out.push({ verb: 'spawn', label: target.teammateId ? 'Spawn a session' : 'Spawn here' });
    if (onHandOver && target.workable) out.push({ verb: 'dispatch', label: 'Dispatch here' });
    if (actions.markDone && target.closable) out.push({ verb: 'close', label: 'Mark done' });
    return out;
  }, [target, actions, onHandOver, view.id]);

  const [verb, setVerb] = useState<Verb | null>(verbs[0]?.verb ?? null);
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const { status, error, run, busy } = useSubmit(onClose);
  const onKeyDown = useFocusTrap(box, onClose);

  /* Anchor: right of the clicked element, flipped left when it would leave
     the viewport, clamped top and bottom. */
  const [place, setPlace] = useState<{ left: number; top: number; flipped: boolean }>(() => placeFor(pick, EST_HEIGHT));
  useLayoutEffect(() => {
    setPlace(placeFor(pick, box.current?.offsetHeight ?? EST_HEIGHT));
  }, [pick, verb, status]);

  useLayoutEffect(() => {
    (textRef.current ?? box.current?.querySelector<HTMLElement>('button'))?.focus();
  }, [pick.entityId]);

  /* A pointerdown outside closes it (the graph re-opens it on another node). */
  useLayoutEffect(() => {
    const away = (ev: PointerEvent) => {
      if (box.current && ev.target instanceof Node && !box.current.contains(ev.target)) onClose();
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [onClose]);

  if (!target) return null;

  const body = text.trim();
  const canGo = !!verb && !busy && (verb === 'close' || verb === 'spawn' || verb === 'dispatch' || !!body);

  const submit = () => {
    if (!verb || !canGo) return;
    if (verb === 'spawn' || verb === 'dispatch') {
      onHandOver?.({
        intent: verb,
        text: body,
        onId: target.teammateId ? view.id : target.id,
        asTeammateId: target.teammateId,
      });
      return;
    }
    if (verb === 'say') {
      const send = actions.sendMessage;
      if (send) void run(() => send(target.messageAnchor, body));
    } else if (verb === 'child') {
      const { add, createTask } = actions;
      if (add) void run(() => add({ intent: TASK_INTENT, text: body, onId: target.id, tellIds: [] }));
      else if (createTask) void run(() => createTask(target.id, body));
    } else if (verb === 'close') {
      const { markDone, sendMessage } = actions;
      if (markDone)
        void run(async () => {
          await markDone(target.id);
          if (body && sendMessage) await sendMessage(target.id, body);
        });
    }
  };

  return (
    <div
      ref={box}
      className={place.flipped ? 'sp-pop sp-pop--flipped' : 'sp-pop'}
      style={{ left: place.left, top: place.top, width: WIDTH }}
      role="dialog"
      aria-modal="true"
      aria-label={target.title}
      onKeyDown={(ev) => {
        if (isSubmitKey(ev, ev.target === textRef.current)) {
          ev.preventDefault();
          submit();
          return;
        }
        onKeyDown(ev);
      }}
    >
      <div className="sp-pop__head">
        <KindIcon kind={target.kind} size={14} />
        <span className="sp-pop__t">{target.title}</span>
        <span className="sp-pop__m">{target.tag}</span>
        <button type="button" className="sp-x" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      {verbs.length > 0 ? (
        <>
          <div className="sp-pop__verbs" role="group" aria-label="What to do">
            {verbs.map((v) => (
              <Opt key={v.verb} on={v.verb === verb} onClick={() => {
                setVerb(v.verb);
                textRef.current?.focus();
              }}>
                {v.label}
              </Opt>
            ))}
          </div>
          <textarea
            ref={textRef}
            className="sp-pop__text"
            rows={3}
            value={text}
            placeholder={verb ? PLACEHOLDER[verb] : ''}
            aria-label={verb ? PLACEHOLDER[verb] : 'Text'}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="sp-pop__foot">
            <span className={status === 'error' ? 'sp-hint sp-hint--error' : 'sp-hint'} role={status === 'error' ? 'alert' : undefined}>
              {status === 'pending' ? 'Working…' : status === 'done' ? 'Done.' : status === 'error' ? error : target.sub}
            </span>
            <button type="button" className="pn-btn pn-btn--primary" disabled={!canGo} onClick={submit}>
              {status === 'pending' ? '…' : status === 'done' ? 'Done' : verb ? GO[verb] : ''}
            </button>
          </div>
        </>
      ) : (
        <div className="sp-pop__foot">
          <span className="sp-hint">{target.sub}</span>
          {actions.open && (
            <button type="button" className="pn-btn" onClick={() => actions.open?.(target.id)}>
              Open
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function placeFor(pick: StoryNodePick, height: number): { left: number; top: number; flipped: boolean } {
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const a = pick.anchor;
  let left = a.x + a.width + GAP;
  let flipped = false;
  if (left + WIDTH > vw - MARGIN) {
    left = a.x - GAP - WIDTH;
    flipped = true;
  }
  left = Math.max(MARGIN, left);
  const top = Math.max(MARGIN, Math.min(a.y - GAP, vh - height - MARGIN));
  return { left, top, flipped };
}
