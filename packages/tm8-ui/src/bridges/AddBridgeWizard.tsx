import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BridgeConnectionView, BridgePolicy, BridgeTargetKind, BridgeView, ConversationItem, EntitySummary,
} from '@tm8/contract';
import { BRIDGE_STYLE_MAX, LAUNCH_MODEL_CATALOG } from '@tm8/contract';
import { useDismissable } from '../panels/useDismissable';
import type { BridgesPort } from './api';
import { BridgeProviderMark, bridgeProviderLabel } from './bridge-marks';
import { ConsequenceDialog } from './ConsequenceDialog';
import { CONNECTION_WORD, TARGET_GLYPH, TARGET_WORD, bridgeFailureOf } from './format';
import { LinkNumberDialog } from './LinkNumberDialog';
import { pendingReason } from './reasons';

/**
 * THE ADD-BRIDGE WIZARD (BRIDGE-ENTITY-DESIGN §4.3; BRIDGES-V2-DESIGN §1.1,
 * §1.2, §1.4).
 *
 *   1 Connection   — one of MY numbers offered to this space, or link one
 *   2 Conversation — the number's live group list (`bridges.conversations.list`,
 *                    never stored); one already connected here is greyed (D20)
 *   3 Target       — chat · session · channel, and the policy the choice
 *                    implies (§2.2), editable, with History & retention.
 *                    A session target can be a NEW session, started at
 *                    Create as the chosen teammate (R11); the bridge keeps it
 *                    running from then on (resumed, else replaced).
 *                    A chat target can be a NEW chat, started at Create
 *                    in the person's own request (`chat.start` is human-only)
 *   4 Test it      — the bridge just created, checked
 *
 * NOTHING IS COMMITTED BEFORE STEP 3's Create (the EditEntityDialog rule):
 * cancelling before it leaves nothing behind. `bridges.create` is human-only
 * and refuses a conversation already connected in the space with the same
 * words step 2 shows, so two members racing cannot both connect it.
 */

type Step = 1 | 2 | 3 | 4;

/** The *New session* choice in the target picker (R11): started at Create. */
export const NEW_SESSION = '__new_session__';
/** The *New chat* choice in the target picker: started at Create, as the chosen teammate and model. */
export const NEW_CHAT = '__new_chat__';
/** Models a new chat can run on: the contract catalog's Claude Code entries. */
const CHAT_MODELS = LAUNCH_MODEL_CATALOG.filter((m) => m.agentTool === 'claude-code');
const DEFAULT_CHAT_MODEL = (CHAT_MODELS.find((m) => m.model === 'claude-opus-5-5') ?? CHAT_MODELS[0])?.model ?? '';
const LIVE_SESSION = new Set(['spawning', 'running', 'idle']);

/** A session the picker should say has stopped (it is resumed by the next message). */
function stoppedSession(t: EntitySummary): boolean {
  return t.state.kind === 'work_session' && !LIVE_SESSION.has(String((t.state as { status?: unknown }).status ?? ''));
}

/** §2.2's default policy, by target kind and conversation kind. */
export function defaultPolicy(target: BridgeTargetKind, conversation: 'group' | 'dm'): Omit<BridgePolicy, 'style'> {
  if (target === 'channel') return { trigger: 'none', direction: 'both', outbound: 'all', whoMayTrigger: 'linked', voice: 'named' };
  return {
    trigger: conversation === 'dm' ? 'every' : 'mention',
    direction: 'both',
    outbound: 'replies',
    whoMayTrigger: conversation === 'dm' ? 'anyone' : 'linked',
    voice: 'named',
  };
}

/** A conversation already connected in this space (D20), keyed by its provider id. */
export function connectedHere(bridges: readonly BridgeView[]): Map<string, BridgeView> {
  return new Map(bridges.filter((b) => b.status !== 'ended').map((b) => [b.conversation.externalId, b]));
}

const CANNOT_SEND: Record<NonNullable<ConversationItem['reason']>, string> = {
  admins_only: 'only admins can post there, and this number is not an admin',
  not_a_member: 'this number is not in the group any more',
};

export function AddBridgeWizard({
  port,
  spaceId,
  initialTargetId,
  onClose,
  onCreated,
}: {
  port: BridgesPort;
  spaceId: string;
  /** Launched from a chat, session or channel: step 3 starts with it chosen. */
  initialTargetId?: string;
  onClose(): void;
  /** Finish: the new bridge, to open its panel. */
  onCreated(bridge: BridgeView): void;
}) {
  const [step, setStep] = useState<Step>(1);
  const [connections, setConnections] = useState<BridgeConnectionView[] | null>(null);
  const [connection, setConnection] = useState<BridgeConnectionView | null>(null);
  const [linking, setLinking] = useState<{ relink: BridgeConnectionView | null } | null>(null);
  const [conversations, setConversations] = useState<ConversationItem[] | null>(null);
  const [existing, setExisting] = useState<Map<string, BridgeView>>(new Map());
  const [search, setSearch] = useState('');
  const [conversation, setConversation] = useState<ConversationItem | null>(null);
  const [targets, setTargets] = useState<EntitySummary[] | null>(null);
  const [targetKind, setTargetKind] = useState<BridgeTargetKind>('chat');
  const [targetId, setTargetId] = useState<string>(initialTargetId ?? (port.startChat ? NEW_CHAT : ''));
  const [teammates, setTeammates] = useState<EntitySummary[] | null>(null);
  const [teammateId, setTeammateId] = useState('');
  const [chatModel, setChatModel] = useState<string>(DEFAULT_CHAT_MODEL);
  const [policy, setPolicy] = useState<Omit<BridgePolicy, 'style'>>(defaultPolicy('chat', 'group'));
  const [style, setStyle] = useState('');
  const [retention, setRetention] = useState<{ forever: boolean; days: number }>({ forever: true, days: 90 });
  const [created, setCreated] = useState<BridgeView | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { if (!busy && !linking && !confirm) onClose(); }, [busy, linking, confirm, onClose]);
  useDismissable(true, dialog, close);

  const reloadConnections = useCallback(async () => {
    try {
      setConnections(await port.connections.list());
    } catch (err) {
      setError(bridgeFailureOf(err));
    }
  }, [port]);

  useEffect(() => {
    void reloadConnections();
    void port.list(spaceId).then((rows) => setExisting(connectedHere(rows)), () => {});
    void port.targets(spaceId).then(setTargets, () => setTargets([]));
    void port.teammates(spaceId).then((rows) => {
      setTeammates(rows);
      setTeammateId((id) => id || rows[0]?.id || '');
    }, () => setTeammates([]));
  }, [port, spaceId, reloadConnections]);

  /* A target handed in by the launcher picks its own kind. */
  useEffect(() => {
    const t = targets?.find((x) => x.id === initialTargetId);
    if (t && (t.kind === 'chat' || t.kind === 'work_session' || t.kind === 'channel')) setTargetKind(t.kind);
  }, [targets, initialTargetId]);

  const convKind: 'group' | 'dm' = conversation?.kind === 'self' ? 'dm' : 'group';
  /* The policy follows the choice until the person edits it; a read-only
     group (it cannot send) starts as WhatsApp → tm8 only (D28). */
  const [policyTouched, setPolicyTouched] = useState(false);
  useEffect(() => {
    if (policyTouched) return;
    const base = defaultPolicy(targetKind, convKind);
    setPolicy(conversation && !conversation.canSend ? { ...base, direction: 'in' } : base);
    setRetention({ forever: convKind === 'group', days: 90 });
  }, [targetKind, convKind, conversation, policyTouched]);

  const offeredHere = (c: BridgeConnectionView) => c.offers.some((o) => o.spaceId === spaceId && o.status === 'active');
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await work(); } catch (err) { setError(bridgeFailureOf(err)); } finally { setBusy(false); }
  };

  const toStep2 = (c: BridgeConnectionView) => run(async () => {
    setConnection(c);
    setConversation(null);
    setConversations(null);
    setStep(2);
    setConversations((await port.conversations(c.id)).items);
  });

  const canStartSession = !!port.startSession;
  const canStartChat = !!port.startChat;
  /* A different kind is a different set of defaults (R7): the choice re-derives them. */
  const chooseKind = (kind: BridgeTargetKind) => {
    setTargetKind(kind);
    setTargetId(kind === 'work_session' && canStartSession ? NEW_SESSION : kind === 'chat' && canStartChat ? NEW_CHAT : '');
    setPolicyTouched(false);
  };

  const create = () => run(async () => {
    if (!connection || !conversation) return;
    const title = `${conversation.name} (${provider})`.slice(0, 80);
    const target = targetId === NEW_SESSION
      ? await port.startSession!(spaceId, { teamMemberId: teammateId, title })
      : targetId === NEW_CHAT
        ? await port.startChat!(spaceId, {
          teammateId, model: chatModel, title,
          body: `This chat answers the ${provider} group "${conversation.name}". Messages there that mention @tm8 arrive here as turns, and your answers go back to the group. Say hello in one line.`,
        })
        : targetId;
    const view = await port.create(spaceId, {
      connectionId: connection.id,
      conversation: {
        externalId: conversation.conversationId,
        kind: convKind,
        title: conversation.name,
        memberCount: conversation.size,
      },
      targetId: target,
      policy: { ...policy, style: style.trim() === '' ? null : style.trim() },
      retentionDays: retention.forever ? null : retention.days,
    });
    setCreated(view);
    setStep(4);
  });

  /* §1.5 on a new bridge: the widening choices say what they mean before Create. */
  const widening = (): string[] => {
    const out: string[] = [];
    const who = conversation?.name ?? 'the group';
    if (policy.whoMayTrigger === 'anyone' && convKind === 'group') {
      out.push(`Anyone in ${who}${conversation?.size ? ` (${conversation.size} people)` : ''}, linked or not, will be able to start agents that spend from the space's credits.`);
    }
    if (policy.trigger === 'every' && convKind === 'group') out.push(`Every message in ${who} will start a turn.`);
    if (policy.outbound === 'all' && targetKind !== 'channel') out.push(`Everything posted in the target — including agents' working notes — will appear in ${who}.`);
    if (policy.direction === 'out') out.push(`Nothing from ${who} will reach tm8; you won't see replies.`);
    return out;
  };
  const onCreate = () => {
    const lines = widening();
    if (lines.length) setConfirm(lines);
    else void create();
  };

  const visible = useMemo(() => {
    const words = search.trim().toLowerCase();
    return (conversations ?? []).filter((c) => !words || c.name.toLowerCase().includes(words));
  }, [conversations, search]);
  const groups = visible.filter((c) => c.kind === 'group');
  const dms = visible.filter((c) => c.kind === 'self');
  const targetChoices = (targets ?? []).filter((t) => t.kind === targetKind);
  /* D25: a target with a bridge cannot take another; say which, instead of refusing at Create. */
  const bridgedTo = useMemo(() => new Map([...existing.values()].map((b) => [b.target.id, b.conversation.title])), [existing]);
  const targetReady = targetId === NEW_SESSION ? teammateId !== ''
    : targetId === NEW_CHAT ? teammateId !== '' && chatModel !== ''
      : targetId !== '';
  /* The contract's bound (1–3650 days); Create waits until it holds (review #1447 r1). */
  const retentionProblem = !retention.forever && (!Number.isInteger(retention.days) || retention.days < 1 || retention.days > 3650)
    ? 'Keep messages for 1 to 3650 days.' : null;
  const provider = bridgeProviderLabel(connection?.provider ?? 'whatsapp');

  return (
    <div className="brg-backdrop">
      <div ref={dialog} className="brg-dialog brg-wiz" role="dialog" aria-modal="true" aria-label="Add bridge" data-testid="add-bridge-wizard">
        <h2 className="brg-dialog__title">
          Add bridge · {step} of 4 · {['Connection', 'Conversation', 'Where it lands and how it behaves', 'Test it'][step - 1]}
        </h2>
        <ol className="brg-wiz__steps" aria-label="Steps">
          {['Connection', 'Conversation', 'Target', 'Test it'].map((s, i) => (
            <li key={s} aria-current={step === i + 1 ? 'step' : undefined} data-done={step > i + 1 || undefined}>{s}</li>
          ))}
        </ol>

        {step === 1 ? (
          <section data-testid="wizard-step-connection">
            <p className="brg-hint">Pick one of your numbers. Only numbers offered to this space can carry a bridge here.</p>
            {connections === null ? <p className="brg-hint" role="status">Loading your numbers…</p> : connections.length === 0 ? (
              <p className="brg-hint">You have not linked a number yet.</p>
            ) : (
              <ul className="brg-wiz__list">
                {connections.filter((c) => c.status !== 'removed').map((c) => {
                  const here = offeredHere(c);
                  const linked = c.status === 'linked';
                  return (
                    <li key={c.id} className="brg-wiz__row">
                      <BridgeProviderMark provider={c.provider} />
                      <span className="brg-wiz__name">{c.label}</span>
                      <span className="brg-mono brg-muted">{c.externalAccountId ?? 'not linked yet'}</span>
                      <span className="brg-muted">{c.status === 'removed' ? 'removed' : CONNECTION_WORD[c.status]}</span>
                      {!linked ? (
                        <button type="button" className="pn-btn" disabled={busy} onClick={() => setLinking({ relink: c })}>Re-link</button>
                      ) : here ? (
                        <button type="button" className="pn-btn pn-btn--primary" disabled={busy} onClick={() => void toStep2(c)} aria-label={`Use ${c.label}`}>Use this number</button>
                      ) : (
                        <button
                          type="button"
                          className="pn-btn"
                          disabled={busy}
                          onClick={() => void run(async () => { await port.connections.offer(c.id, spaceId); await reloadConnections(); })}
                          aria-label={`Offer ${c.label} to this space`}
                        >
                          Offer to this space
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <button type="button" className="pn-btn" disabled={busy} onClick={() => setLinking({ relink: null })}>+ Link a new number</button>
            <p className="brg-hint">Slack, Telegram and Discord arrive with their own runtimes; this node links WhatsApp numbers.</p>
          </section>
        ) : null}

        {step === 2 ? (
          <section data-testid="wizard-step-conversation">
            <p className="brg-hint">
              {connection?.label}'s groups, as WhatsApp lists them right now. Nothing here is stored; only the group you
              connect is read from now on.
            </p>
            <input
              type="search"
              className="brg-wiz__search"
              placeholder="Search groups"
              aria-label="Search groups"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {conversations === null ? (
              <p className="brg-hint" role="status">{error ? '' : 'Asking WhatsApp for the group list…'}</p>
            ) : (
              <>
                {[['GROUPS', groups], ['DIRECT', dms]].map(([label, items]) => (items as ConversationItem[]).length ? (
                  <div key={label as string}>
                    <h3 className="set-eyebrow brg-subhead">{label as string}</h3>
                    <ul className="brg-wiz__list" role="listbox" aria-label={`${label as string} conversations`}>
                      {(items as ConversationItem[]).map((c) => {
                        const taken = existing.get(c.conversationId);
                        return (
                          <li key={c.conversationId}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={conversation?.conversationId === c.conversationId}
                              className="brg-wiz__pick"
                              disabled={!!taken}
                              onClick={() => { setConversation(c); setPolicyTouched(false); }}
                            >
                              <span className="brg-wiz__name">{c.name}</span>
                              <span className="brg-muted">{c.kind === 'self' ? 'you' : c.size != null ? `${c.size} people` : 'group'}</span>
                              {taken ? (
                                <span className="brg-muted">already connected → {taken.target.title}</span>
                              ) : !c.canSend && c.reason ? (
                                <span className="brg-warn">read-only: {CANNOT_SEND[c.reason]}</span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null)}
                {visible.length === 0 ? <p className="brg-hint">No group matches.</p> : null}
              </>
            )}
          </section>
        ) : null}

        {step === 3 ? (
          <section data-testid="wizard-step-target">
            <div className="brg-wiz__cards" role="radiogroup" aria-label="Lands in">
              {([
                ['chat', 'A chat: each message to @tm8 is a turn; the chat\'s teammate answers in the group.'],
                ['work_session', 'A session: messages to @tm8 go to one session, which answers in the group. The bridge keeps it running; /new in the group starts a fresh one.'],
                ['channel', 'A channel: a mirror. Every message is copied both ways; nothing answers unless someone is @mentioned.'],
              ] as const).map(([kind, words]) => (
                <label key={kind} className="brg-wiz__card" data-selected={targetKind === kind || undefined}>
                  <input type="radio" name="targetKind" checked={targetKind === kind} onChange={() => chooseKind(kind)} />
                  <span className="brg-wiz__name">{TARGET_GLYPH[kind]} {TARGET_WORD[kind][0]!.toUpperCase() + TARGET_WORD[kind].slice(1)}</span>
                  <span className="brg-hint">{words}</span>
                </label>
              ))}
            </div>
            <label className="brg-form__line">
              <span className="set-eyebrow">Lands in</span>
              <select aria-label="Target" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                {targetKind === 'work_session' && canStartSession ? (
                  <option value={NEW_SESSION}>＋ New session for this group</option>
                ) : targetKind === 'chat' && canStartChat ? (
                  <option value={NEW_CHAT}>＋ New chat for this group</option>
                ) : (
                  <option value="">{targetChoices.length ? `Choose a ${TARGET_WORD[targetKind]}…` : `No ${TARGET_WORD[targetKind]} in this space yet`}</option>
                )}
                {targetChoices.map((t) => {
                  const taken = bridgedTo.get(t.id);
                  return (
                    <option key={t.id} value={t.id} disabled={!!taken}>
                      {t.title}{taken ? ` — already bridged to ${taken}` : stoppedSession(t) ? ' (stopped: the next message resumes it)' : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            {targetId === NEW_SESSION || targetId === NEW_CHAT ? (
              <label className="brg-form__line">
                <span className="set-eyebrow">Runs as</span>
                <select aria-label="Runs as" value={teammateId} onChange={(e) => setTeammateId(e.target.value)}>
                  {(teammates ?? []).length === 0 ? <option value="">No teammate in this space yet</option> : null}
                  {(teammates ?? []).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                </select>
              </label>
            ) : null}
            {targetId === NEW_CHAT ? (
              <label className="brg-form__line">
                <span className="set-eyebrow">Model</span>
                <select aria-label="Model" value={chatModel} onChange={(e) => setChatModel(e.target.value)}>
                  {CHAT_MODELS.map((m) => <option key={m.model} value={m.model}>{m.label}</option>)}
                </select>
              </label>
            ) : null}
            <p className="brg-hint">
              {targetKind === 'chat'
                ? targetId === NEW_CHAT
                  ? 'The new chat opens with a note saying it answers this group, and its teammate says hello there in tm8 (not in the group).'
                  : 'Each message to @tm8 becomes a turn in this chat.'
                : targetKind === 'work_session'
                  ? 'If the session stops, the next message resumes it, or starts a new one and tells the group.'
                  : 'Pick the channel the group is mirrored into.'}
            </p>

            <fieldset className="brg-form__fields" onChange={() => setPolicyTouched(true)}>
              {/* R7: a channel mirrors everything; when tm8 answers and what goes back do not apply. */}
              {targetKind !== 'channel' ? (
                <>
                  <WizardChoice legend="When does tm8 answer?" name="w-trigger" value={policy.trigger}
                    onChange={(v) => setPolicy((p) => ({ ...p, trigger: v }))}
                    options={[['mention', 'Only when someone writes @tm8 or replies to tm8'], ['every', 'Every message'], ['none', 'Never — log only']]} />
                  <WizardChoice legend={`What from tm8 goes back to ${provider}?`} name="w-outbound" value={policy.outbound}
                    onChange={(v) => setPolicy((p) => ({ ...p, outbound: v }))}
                    options={[['replies', 'Answers, and anything posted on the bridge', 'e.g. tm8\'s reply to "@tm8 is the deploy done?"'], ['all', `Also everything posted in the ${TARGET_WORD[targetKind]}`, 'e.g. your own notes and agents\' updates there']]} />
                </>
              ) : null}
              <WizardChoice legend="Which way do messages flow?" name="w-direction" value={policy.direction}
                onChange={(v) => setPolicy((p) => ({ ...p, direction: v }))}
                options={[['both', 'Both ways'], ['in', `${provider} → tm8 only`], ['out', `tm8 → ${provider} only`]]} />
              {targetKind !== 'channel' ? (
                <WizardChoice legend="Who can start agents?" name="w-who" value={policy.whoMayTrigger}
                  onChange={(v) => setPolicy((p) => ({ ...p, whoMayTrigger: v }))}
                  options={[['linked', 'Only people who have verified their number in tm8'], ['anyone', 'Anyone in the group', 'you\'ll confirm']]} />
              ) : null}
              <WizardChoice legend="How replies are signed" name="w-voice" value={policy.voice}
                onChange={(v) => setPolicy((p) => ({ ...p, voice: v }))}
                options={[['named', '"tm8:" / "Release notes (keen-otter):"'], ['plain', 'No prefix']]} />
              <label className="brg-form__line">
                <span className="set-eyebrow">Style</span>
                <input type="text" value={style} maxLength={BRIDGE_STYLE_MAX} placeholder="short and readable: lead with the answer…" onChange={(e) => setStyle(e.target.value)} />
                <span className="brg-muted">{style.length}/{BRIDGE_STYLE_MAX}</span>
              </label>
              <details className="brg-group">
                <summary>History &amp; retention ({retention.forever ? 'forever' : `${retention.days} days`} · no import)</summary>
                <WizardChoice legend="Keep messages" name="w-retention" value={retention.forever ? 'forever' : 'days'}
                  onChange={(v) => setRetention((r) => ({ ...r, forever: v === 'forever' }))}
                  options={[['forever', 'Forever'], ['days', 'For a number of days, then delete them here', `${provider} keeps its own copy`]]} />
                {!retention.forever ? (
                  <label className="brg-form__line">
                    <span>Days</span>
                    <input type="number" min={1} max={3650} aria-label="Keep messages for days" value={retention.days}
                      onChange={(e) => setRetention((r) => ({ ...r, days: Number(e.target.value) }))} />
                  </label>
                ) : null}
                {retentionProblem ? <p className="brg-error" role="alert">{retentionProblem}</p> : null}
                <p className="brg-hint">{pendingReason(port, 'bridges.history.import', 'Importing earlier messages')}</p>
              </details>
            </fieldset>
          </section>
        ) : null}

        {step === 4 && created ? (
          <section data-testid="wizard-step-test">
            <ul className="brg-wiz__checks">
              <li data-ok>✓ Connected to {provider} {connection?.externalAccountId ?? connection?.label}</li>
              <li data-ok>✓ tm8 can read “{conversation?.name}”{conversation?.size ? ` (${conversation.size} people)` : ''}</li>
              <li data-ok>✓ The bridge is {created.status}: it lands in {created.target.title}</li>
              <li>◌ Send a test message to the group — {pendingReason(port, 'bridges.test', 'The test message')}</li>
              <li>◌ {testLine(created.target.kind, created.target.title, provider)}</li>
            </ul>
            <p className="brg-hint">Finish is fine either way: if anything fails later, Health on the bridge says why.</p>
          </section>
        ) : null}

        {error ? <p className="brg-error" role="alert">{error}</p> : null}
        <div className="brg-dialog__actions">
          {step === 4 ? null : <button type="button" className="pn-btn" onClick={onClose} disabled={busy}>Cancel</button>}
          {step === 2 || step === 3 ? (
            <button type="button" className="pn-btn" disabled={busy} onClick={() => setStep((s) => (s - 1) as Step)}>Back</button>
          ) : null}
          {step === 2 ? (
            <button type="button" className="pn-btn pn-btn--primary" disabled={!conversation || busy} onClick={() => setStep(3)}>Next: where it lands</button>
          ) : null}
          {step === 3 ? (
            <button type="button" className="pn-btn pn-btn--primary" disabled={!targetReady || busy || retentionProblem !== null} onClick={onCreate}>
              {busy ? 'Creating…' : 'Create bridge'}
            </button>
          ) : null}
          {step === 4 && created ? (
            <button type="button" className="pn-btn pn-btn--primary" onClick={() => onCreated(created)}>Finish</button>
          ) : null}
        </div>
      </div>

      {linking ? (
        <LinkNumberDialog
          port={port}
          spaceId={spaceId}
          relink={linking.relink}
          onClose={() => setLinking(null)}
          onLinked={(c) => { setLinking(null); void reloadConnections().then(() => { if (c.offers.some((o) => o.spaceId === spaceId)) void toStep2(c); }); }}
        />
      ) : null}
      {confirm ? (
        <ConsequenceDialog
          title={`Create the ${conversation?.name ?? ''} bridge like this?`}
          consequences={confirm}
          confirmLabel="Yes, create it"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => { setConfirm(null); await create(); }}
        />
      ) : null}
    </div>
  );
}

/** Step 4's live check, per kind (R7): where the question lands and where the answer appears. */
export function testLine(kind: BridgeTargetKind, title: string, provider: string): string {
  if (kind === 'channel') return `Now send a message from your phone; it appears in #${title}, and a reply there appears in ${provider}.`;
  if (kind === 'work_session') return `Now send "@tm8 ping" from your phone; ${title} gets it and answers in ${provider}. If nothing comes back, check that your number is verified (Account → Linked identities).`;
  return `Now send "@tm8 ping" from your phone; ${title} answers in ${provider}. If nothing comes back, check that your number is verified (Account → Linked identities).`;
}

function WizardChoice<V extends string>({
  legend, name, value, onChange, options,
}: {
  legend: string;
  name: string;
  value: V;
  onChange(v: V): void;
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
