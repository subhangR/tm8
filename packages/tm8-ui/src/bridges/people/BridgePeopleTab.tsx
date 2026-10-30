/**
 * The bridge panel's People tab (BRIDGE-ENTITY-DESIGN §2.4, §4.4, D50-D52).
 *
 * The participant roster: who has spoken in the provider conversation, and who
 * each of them IS in this space. Participants are presence rows, not entities
 * (§2.4), so a guest gets initials in the idle tone and no chip; a linked or
 * asserted row shows the member it counts as.
 *
 * THE TRUST WORD IS THE SERVER'S. `linked ✓` is a link the person proved from
 * their own phone; `asserted` is an admin's say-so and is never drawn as
 * verified; `guest` is everyone else, including a member who left. The tab
 * renders `trust` as given and never derives it from the member chip.
 *
 * MASKING IS THE SERVER'S TOO. A member sees `…9494`; a space admin sees the
 * id. The tab has no way to unmask and no code path that tries.
 *
 * ROW ACTIONS are an admin's (D52): *Mute*, *This is…* (assert a member) and
 * *Revoke assertion*. A verified link is the person's own, so no admin action
 * touches it. *Invite to space* belongs to B3 and arrives through
 * `renderInvite`. *This is me* waits for `bridges.links.*`. A refusal is shown
 * as the server worded it.
 *
 * Handles are not here: they live in Routing (§4.4), which the panel owns.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ActorSummary, BridgeParticipant, BridgeParticipantTrust } from '@tm8/contract';
import { ActorRef } from '../../kit/ActorRef';
import { Avatar } from '../../kit/Avatar';
import { Pill, type PillTone } from '../../kit/Pill';
import { relTime, useNow } from '../../kit/time';
import type { BridgeParticipantPatch, BridgePeoplePort } from './port';
import './people.css';

export interface BridgePeopleTabProps {
  bridgeId: string;
  port: BridgePeoplePort;
  /** Host navigation for a member chip. Absent ⇒ the chip is inert. */
  onOpenEntity?: (id: string) => void;
  /** B3's *Invite to space*, drawn on an admin's guest rows when the host supplies it. */
  renderInvite?: (participant: BridgeParticipant) => ReactNode;
}

type Filter = 'all' | 'linked' | 'guests';

const TRUST: Record<BridgeParticipantTrust, { word: string; tone: PillTone; title: string }> = {
  linked: { word: 'linked ✓', tone: 'run', title: 'They linked this number to their account themselves' },
  asserted: { word: 'asserted', tone: 'wait', title: 'A space admin said who this is; not verified' },
  guest: { word: 'guest', tone: 'idle', title: 'Not linked to anyone in this space' },
};

function failureOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  return code === 'forbidden' || code === 'conflict' ? `Refused: ${message}` : message;
}

const nameOf = (p: BridgeParticipant) => p.displayName?.trim() || 'No name';
const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

export function BridgePeopleTab({ bridgeId, port, onOpenEntity, renderInvite }: BridgePeopleTabProps) {
  const [rows, setRows] = useState<BridgeParticipant[] | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [admin, setAdmin] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [members, setMembers] = useState<ActorSummary[] | null>(null);
  /** The row whose *This is…* picker is open, by external id. */
  const [asserting, setAsserting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);
  const now = useNow();

  useEffect(() => {
    let live = true;
    setRows(null);
    void port.participants(bridgeId).then(
      (page) => {
        if (!live) return;
        setRows(page.items); setSpaceId(page.spaceId); setAdmin(page.admin); setLoadError(null);
      },
      (err: unknown) => { if (live) setLoadError(failureOf(err)); },
    );
    return () => { live = false; };
  }, [bridgeId, port]);

  // The picker's members load once, and only for an admin who opens one.
  useEffect(() => {
    if (!asserting || members || !spaceId) return;
    let live = true;
    void port.members(spaceId).then(
      (next) => { if (live) setMembers(next.filter((m) => m.kind === 'member')); },
      (err: unknown) => { if (live) setNotice({ tone: 'fail', text: failureOf(err) }); },
    );
    return () => { live = false; };
  }, [asserting, members, spaceId, port]);

  const apply = useCallback(async (p: BridgeParticipant, patch: BridgeParticipantPatch, done: string) => {
    setBusy(p.externalId); setNotice(null);
    try {
      const next = await port.update(bridgeId, p.externalId, patch);
      setRows((prev) => prev?.map((r) => (r.externalId === p.externalId ? next : r)) ?? prev);
      setAsserting(null);
      setNotice({ tone: 'ok', text: done });
    } catch (err) {
      setNotice({ tone: 'fail', text: failureOf(err) });
    } finally {
      setBusy(null);
    }
  }, [bridgeId, port]);

  const counts = useMemo(() => {
    const all = rows ?? [];
    const linked = all.filter((r) => r.trust !== 'guest').length;
    return { all: all.length, linked, guests: all.length - linked };
  }, [rows]);

  const shown = useMemo(() => (rows ?? []).filter((r) =>
    filter === 'all' ? true : filter === 'linked' ? r.trust !== 'guest' : r.trust === 'guest'), [rows, filter]);

  if (loadError) {
    return <div className="brp" data-testid="bridge-people"><p className="brp__fail" role="alert">{loadError}</p></div>;
  }
  if (!rows) {
    return <div className="brp" data-testid="bridge-people"><p className="brp__muted">Loading people…</p></div>;
  }

  return (
    <div className="brp" data-testid="bridge-people">
      <div className="brp__bar">
        <p className="brp__summary">
          {`${counts.all} ${counts.all === 1 ? 'person' : 'people'} · ${counts.linked} linked · ${counts.guests} ${counts.guests === 1 ? 'guest' : 'guests'}`}
        </p>
        <div className="brp__filter" role="radiogroup" aria-label="Show">
          {(['all', 'linked', 'guests'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              className={filter === f ? 'brp__seg brp__seg--on' : 'brp__seg'}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'linked' ? 'Linked' : 'Guests'}
            </button>
          ))}
        </div>
      </div>
      <p className="brp__muted">
        {admin
          ? 'You are an admin of this space, so numbers are shown in full.'
          : 'Numbers are masked. Space admins see them in full.'}
      </p>
      {notice ? (
        <p className={notice.tone === 'ok' ? 'brp__notice' : 'brp__fail'} role={notice.tone === 'fail' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      ) : null}

      {shown.length === 0 ? (
        <p className="brp__empty">
          {rows.length === 0
            ? 'Nobody has spoken on this bridge yet. People appear here as their messages arrive.'
            : filter === 'linked' ? 'Nobody here is linked yet.' : 'No guests.'}
        </p>
      ) : (
        <ul className="brp__list" aria-label="Participants">
          {shown.map((p) => {
            const name = nameOf(p);
            const trust = TRUST[p.trust];
            const isBusy = busy === p.externalId;
            return (
              <li key={p.externalId} className="brp__row" data-testid="bridge-participant" data-trust={p.trust}>
                {p.member ? (
                  <Avatar actorId={p.member.id} provenance="human" label={name} size={32} />
                ) : (
                  <span className="brp__guest-avatar" aria-label={name} title={name}>{initialsOf(name)}</span>
                )}
                <div className="brp__who">
                  <div className="brp__line">
                    <span className="brp__name">{name}</span>
                    <Pill tone={trust.tone} title={trust.title}>{trust.word}</Pill>
                    {p.muted ? <Pill tone="block" title="Their messages are not delivered to tm8">muted</Pill> : null}
                    {p.you ? <span className="brp__you">you</span> : null}
                  </div>
                  <div className="brp__line brp__meta">
                    <span className="brp__id" title={p.masked ? 'Masked: space admins see the full id' : undefined}>{p.externalId}</span>
                    <span>{`last seen ${relTime(p.lastSeenAt, now)}`}</span>
                    <span>{`${p.messageCount} ${p.messageCount === 1 ? 'message' : 'messages'}`}</span>
                    {p.member ? (
                      <span className="brp__member">
                        <span>counts as</span>
                        {onOpenEntity ? (
                          <button type="button" className="brp__chip" onClick={() => onOpenEntity(p.member!.id)}>
                            <ActorRef actor={p.member} />
                          </button>
                        ) : <ActorRef actor={p.member} />}
                      </span>
                    ) : null}
                  </div>
                  {asserting === p.externalId ? (
                    <AssertPicker
                      name={name}
                      members={members}
                      busy={isBusy}
                      onCancel={() => setAsserting(null)}
                      onAssert={(m) => void apply(p, { memberId: m.id }, `${name} now counts as ${m.displayName} (asserted).`)}
                    />
                  ) : null}
                </div>
                {admin ? (
                  <div className="brp__actions">
                    {p.trust === 'guest' && asserting !== p.externalId ? (
                      <button type="button" className="brp__btn" disabled={isBusy} onClick={() => { setNotice(null); setAsserting(p.externalId); }}>
                        This is…
                      </button>
                    ) : null}
                    {p.trust === 'guest' && renderInvite ? renderInvite(p) : null}
                    {p.trust === 'asserted' ? (
                      <button type="button" className="brp__btn" disabled={isBusy}
                        onClick={() => void apply(p, { memberId: null }, `Assertion on ${name} revoked; they are a guest again.`)}>
                        Revoke assertion
                      </button>
                    ) : null}
                    <button type="button" className="brp__btn" disabled={isBusy}
                      onClick={() => void apply(p, { muted: !p.muted }, p.muted ? `${name} unmuted.` : `${name} muted.`)}>
                      {p.muted ? 'Unmute' : 'Mute'}
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AssertPicker({ name, members, busy, onAssert, onCancel }: {
  name: string;
  members: ActorSummary[] | null;
  busy: boolean;
  onAssert: (member: ActorSummary) => void;
  onCancel: () => void;
}) {
  const [chosen, setChosen] = useState('');
  const member = members?.find((m) => m.id === chosen) ?? null;
  return (
    <div className="brp__assert" data-testid="bridge-assert">
      <p className="brp__muted">
        {`Say who ${name} is. Their messages will count as that member in this space only, marked asserted, not verified.`}
      </p>
      <div className="brp__line">
        <select
          className="brp__select"
          aria-label={`Member ${name} is`}
          value={chosen}
          disabled={!members || busy}
          onChange={(e) => setChosen(e.target.value)}
        >
          <option value="">{members ? 'Choose a member…' : 'Loading members…'}</option>
          {members?.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
        </select>
        <button type="button" className="brp__btn brp__btn--primary" disabled={!member || busy} onClick={() => member && onAssert(member)}>
          Assert
        </button>
        <button type="button" className="brp__btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
