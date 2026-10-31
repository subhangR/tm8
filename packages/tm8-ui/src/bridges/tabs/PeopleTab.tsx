import type { BridgeDetailView } from '@tm8/contract';
import { shortDate } from '../../kit/time';

/**
 * PEOPLE (§4.4). The participant roster and its row actions (mute, assert,
 * unlink, invite) are lane P's `BridgePeopleTab` over
 * `bridges.participants.list`; whichever of the two PRs merges second mounts
 * it here, in place of the roster note below. Until then this tab draws what
 * `bridges.get` already answers: the counts, and who has been posting
 * through the bridge (from the outbox, D23).
 */
export function PeopleTab({ view }: { view: BridgeDetailView }) {
  const { participants, linked, guestsSeen7d } = view.people;
  return (
    <div className="brg-people" data-testid="bridge-people">
      <dl className="brg-facts">
        <div><dt>Participants seen</dt><dd>{participants}</dd></div>
        <div><dt>Linked to members</dt><dd>{linked}</dd></div>
        <div><dt>Guests seen this week</dt><dd>{guestsSeen7d}</dd></div>
      </dl>
      <p className="brg-hint" data-testid="bridge-people-roster-note">
        The roster (each person, their link state, mute and <em>This is…</em>) arrives with
        bridges.participants.list.
      </p>
      <h3 className="set-eyebrow brg-subhead">Posting through this bridge</h3>
      {view.recentPosters.length === 0 ? (
        <p className="brg-hint">Nobody in tm8 has posted through this bridge yet.</p>
      ) : (
        <table className="brg-table">
          <thead><tr><th scope="col">Who</th><th scope="col">Handle</th><th scope="col">Posts</th><th scope="col">Last</th></tr></thead>
          <tbody>
            {view.recentPosters.map((p) => (
              <tr key={p.actorId}>
                <td>{p.displayName}</td>
                <td className="brg-mono">{p.handle ?? '—'}</td>
                <td>{p.posts}</td>
                <td>{shortDate(p.lastPostAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
