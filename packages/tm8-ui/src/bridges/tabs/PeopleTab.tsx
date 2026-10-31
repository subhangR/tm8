import type { BridgeDetailView } from '@tm8/contract';
import { shortDate } from '../../kit/time';
import type { BridgesPort } from '../api';
import { InviteToSpace } from '../invite';
import { BridgePeopleTab } from '../people';

/**
 * PEOPLE (§4.4). Where the node serves it (`port.people`), the roster is lane
 * P's `BridgePeopleTab` over `bridges.participants.*` (D50-D52), with B3's
 * *Invite to space* on guest rows (D60). Otherwise, as on the fixture seam,
 * the tab draws what `bridges.get` already answers: the counts. Who has been
 * posting through the bridge (from the outbox, D23) shows in both.
 */
export function PeopleTab({ view, port, onOpenEntity }: {
  view: BridgeDetailView;
  port: BridgesPort;
  onOpenEntity?: (id: string) => void;
}) {
  const { participants, linked, guestsSeen7d } = view.people;
  const createInvite = port.createInvite;
  if (port.people) {
    return (
      <div className="brg-people">
        <BridgePeopleTab
          bridgeId={view.id}
          port={port.people}
          onOpenEntity={onOpenEntity}
          renderInvite={createInvite
            ? (p) => <InviteToSpace spaceId={view.spaceId} bridgeId={view.id} participant={p} createInvite={createInvite} />
            : undefined}
        />
        <Posters view={view} />
      </div>
    );
  }
  return (
    <div className="brg-people" data-testid="bridge-people">
      <dl className="brg-facts">
        <div><dt>Participants seen</dt><dd>{participants}</dd></div>
        <div><dt>Linked to members</dt><dd>{linked}</dd></div>
        <div><dt>Guests seen this week</dt><dd>{guestsSeen7d}</dd></div>
      </dl>
      <p className="brg-hint" data-testid="bridge-people-roster-note">
        The roster (each person, their link state, mute and <em>This is…</em>) shows where this
        node serves bridges.participants.list.
      </p>
      <Posters view={view} />
    </div>
  );
}

function Posters({ view }: { view: BridgeDetailView }) {
  return (
    <>
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
    </>
  );
}
