/**
 * SERVER — a named road to another tm8 node.
 *
 * Signature moment: THE HOP. Three stations (your CLI, this Server, the named
 * Server) arrive left to right, and the credential chip that rides along is
 * left behind at the middle station. It is the one thing a reader must take
 * away: `--server` resolves a NAME through the local node and then talks to
 * the other node directly, and the local node's token never crosses
 * (`cli/src/server-target.ts`: "a hop is a pipe, never an identity
 * boundary"). Under reduced motion the three stations stand together and the
 * sentence under each carries the whole meaning.
 *
 * Facts checked against this build: `cli/src/commands/server.ts` (the /health
 * check, `tm8-server` identity, contract version), migration 261 (the servers
 * detail row, reach statuses, 044 rows read-only, removal refused while a space
 * link targets it), `server/src/remote/server-store.ts` (the probe) and the
 * registry's managed panel (remote forwarding refused in this build).
 */
import type { CSSProperties, ReactNode } from 'react';
import { Reveal } from '../motion/Reveal';
import type { KindHelpModule } from '../types';

const hop: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr)',
  gap: 'var(--pn-space-2)',
  margin: 'var(--pn-space-4) 0 var(--pn-space-2)',
};

const station: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--pn-space-2)',
  height: '100%',
  boxSizing: 'border-box',
  padding: 'var(--pn-space-3)',
  background: 'var(--eh-card)',
  border: '1px solid var(--eh-line)',
  borderRadius: 'var(--pn-r-md)',
  boxShadow: 'var(--pn-sh-sm)',
};

const stationEyebrow: CSSProperties = {
  fontFamily: 'var(--pn-mono)',
  fontSize: 'var(--pn-fs-fine)',
  letterSpacing: 'var(--pn-track-label)',
  textTransform: 'uppercase',
  color: 'var(--eh-ink-3)',
};

const stationName: CSSProperties = {
  fontFamily: 'var(--pn-serif)',
  fontSize: 'var(--pn-fs-sm)',
  fontWeight: 600,
  color: 'var(--eh-ink)',
};

const stationNote: CSSProperties = {
  fontSize: 'var(--pn-fs-label)',
  lineHeight: 'var(--pn-lh-snug)',
  color: 'var(--eh-ink-2)',
};

const chipBase: CSSProperties = {
  alignSelf: 'flex-start',
  fontFamily: 'var(--pn-mono)',
  fontSize: 'var(--pn-fs-fine)',
  padding: '2px var(--pn-space-2)',
  borderRadius: 'var(--pn-r-pill)',
  border: '1px solid var(--eh-line)',
};

const chipCarried: CSSProperties = { ...chipBase, background: 'var(--pn-brand-soft)', color: 'var(--eh-ink)' };
const chipDropped: CSSProperties = {
  ...chipBase,
  background: 'var(--pn-block-soft)',
  color: 'var(--pn-block)',
  textDecoration: 'line-through',
};
const chipFresh: CSSProperties = { ...chipBase, background: 'var(--pn-run-soft)', color: 'var(--pn-run)' };

const arrow: CSSProperties = {
  alignSelf: 'center',
  width: '22px',
  height: '22px',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '50%',
  background: 'var(--eh-surface)',
  border: '1px solid var(--eh-line)',
  color: 'var(--eh-brass)',
  fontSize: 'var(--pn-fs-fine)',
};

/** The wire between two stations: its own grid cell, so no card paints over it. */
function Wire({ delay }: { delay: number }) {
  return (
    <Reveal delay={delay}>
      <span style={{ display: 'grid', height: '100%', placeItems: 'center' }}>
        <span style={arrow} aria-hidden>
          →
        </span>
      </span>
    </Reveal>
  );
}

function Station({
  eyebrow,
  name,
  chip,
  chipStyle,
  children,
}: {
  eyebrow: string;
  name: string;
  chip: string;
  chipStyle: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div style={station}>
      <span style={stationEyebrow}>{eyebrow}</span>
      <span style={stationName}>{name}</span>
      <span style={chipStyle}>{chip}</span>
      <span style={stationNote}>{children}</span>
    </div>
  );
}

export const SERVER_HELP: KindHelpModule = {
  kind: 'server',
  story: {
    logline: 'A server is a name your Space gives to another tm8 node, so everyone in it can find the same road.',
    opening: (
      <>
        <p>
          A <strong>server</strong> is a short name, like <code>staging</code>, pinned to the address of another tm8
          node. It lives in one Space, so every member of that Space sees the same name, the same address and the
          last time anyone checked that the other end was alive. It holds no password and no token.
        </p>
        <p>
          Before a server was an entity, a named route was a node-local setting that only a node admin could see. It
          belonged to the machine, not to any Space. Now the name is a record the Space owns: a space link can target
          it, every member reads the same address, and removing it is a decision everyone can see.
        </p>
      </>
    ),
    beats: [
      {
        eyebrow: 'The signature',
        title: 'The hop carries a name, never your identity',
        body: (
          <>
            <p>
              Add <code>--server</code> and a name to any command. Your CLI asks this node what the name
              means, gets back an address, and then talks to that address itself. The token that got you into this
              node stays behind. Only a credential you stored for the other node&rsquo;s own address goes with the
              call, or none does.
            </p>
            <HopFigure />
          </>
        ),
      },
      {
        eyebrow: 'How it is born',
        title: 'Added only after the other end answers as tm8',
        body: (
          <p>
            <code>tm8 server add</code> is a human act. It is refused to agents, and it first asks the address for its{' '}
            <code>/health</code>. The answer must say it is a tm8 Server on the same contract version as your CLI, or
            nothing is written. A server that exists has, at least once, been who it claimed to be.
          </p>
        ),
      },
      {
        eyebrow: 'How it lives',
        title: 'Reachability is a fact someone checked',
        body: (
          <p>
            A new server reads <em>Not checked yet</em>. <strong>Check reachability</strong> on its panel sends an
            unauthenticated request to its <code>/health</code> and records one of three answers: reachable,
            unreachable, or offline. Unreachable means the guard refused the address, for example a private network or
            bad TLS. Offline means the connection was refused, reset, or got no answer in time. The time of the check is kept beside the verdict, so
            a stale green is visibly stale.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Remote forwarding is off in this build',
        body: (
          <p>
            An agent here cannot act on a server <em>through</em> this node. Every remote call is refused with{' '}
            <code>remote_links_disabled</code>, and turning that on is a code change, not a setting. The record is
            real and the address is real. What this node will not do is carry work across it on your behalf.
          </p>
        ),
      },
      {
        eyebrow: 'How it ends',
        title: 'Removed for everyone, and not while a link leans on it',
        body: (
          <p>
            <code>tm8 server remove</code> belongs to whoever added the server or to a Space admin. It asks for{' '}
            <code>--yes</code> because the name disappears for every member at once. While a space link still targets
            the server, removal is refused. Remove the link first, so no link is left pointing at nothing.
          </p>
        ),
      },
    ],
    lifecycle: [
      { name: 'Health-checked', note: 'The address answers /health as a tm8 Server on your contract version.' },
      { name: 'Added', note: 'Written to one Space by a human. Every member now sees the name.' },
      { name: 'Not checked yet', note: 'Reachability starts unknown. Nobody has asked since it was added.' },
      { name: 'Checked', note: 'Reachable, unreachable or offline, stamped with when it was asked.' },
      { name: 'Removed', note: 'Gone for the whole Space, and only once no space link targets it.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        The <code>server</code> noun is small on purpose. It keeps names, and the real work happens on the node at
        the end of the name. Reads are open to every member. Writes need a human session, because a server is a
        decision a person makes on behalf of the whole Space.
      </p>
    ),
    scenes: [
      {
        title: 'Find the roads you already have',
        narrative: (
          <p>
            <code>tm8 server list</code> shows every server in your Spaces. For a node admin it also shows the node&rsquo;s
            older local routes that no server has adopted yet. <code>tm8 server get</code> reads one by name. If two
            of your Spaces use the same name, it refuses instead of guessing.
          </p>
        ),
        commands: ['server list', 'server get'],
        demo: ['# which nodes does this Space know by name?', 'tm8 server list', 'tm8 server get staging'],
      },
      {
        title: 'Name a new node',
        narrative: (
          <p>
            Give <code>tm8 server add</code> a short lowercase name and the node&rsquo;s base URL. It checks{' '}
            <code>/health</code> before it writes anything. Without <code>--space</code>, the server joins your first
            Space. <code>--username</code> records which account you use over there, for the panel. It is not a
            credential.
          </p>
        ),
        commands: ['server add'],
      },
      {
        title: 'Know which end you are standing on',
        narrative: (
          <p>
            Before you trust a call made with <code>--server</code>, ask the node you reached who it thinks you are.{' '}
            <code>tm8 identity get</code> reports the actor that node resolved, and <code>tm8 node mode</code> reports
            whether it runs single or multi. You only get an honest answer from a node you are really talking to.
          </p>
        ),
        commands: ['identity get', 'node mode'],
        demo: ['# which node, and as whom?', 'tm8 identity get', 'tm8 node mode'],
      },
      {
        title: 'Retire a name',
        narrative: (
          <p>
            <code>tm8 server remove</code> takes a name or an id and <code>--yes</code>. If a space link still targets
            the server, the refusal names the link as the reason. Remove the link first and try again.
          </p>
        ),
        commands: ['server remove'],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        No edge type names a server. Its strongest tie, a space link targeting it, is a column on the link rather
        than an edge, which is why removal checks it. What you see here are the edges every entity shares: the
        conversation that hangs on a server, the memories that are about it, and the collections that gather it.
      </p>
    ),
    notes: {
      'anchored_to:incoming': 'Talk about a node where the node is: a thread on the server outlives any one chat.',
      'about:incoming': 'A memory or chat filed about this server. Useful for what the address alone cannot say.',
      'contains:incoming': 'Collect servers with a curated list, for example the nodes a release goes through.',
      'relates_to:outgoing': 'The general link, when a task or doc concerns this node and no sharper verb fits.',
    },
    spotlight: ['message', 'memory', 'collection'],
  },
};

/**
 * THE HOP — the signature moment. Three stations arrive left to right; the
 * token chip is struck through at the middle one. Each station is its own
 * Reveal (Stagger's wrapper takes no style, and the row needs a grid); the
 * wires are grid cells of their own so a later card never paints over them.
 */
function HopFigure() {
  return (
    <figure style={{ margin: 0 }} aria-label="How a call reaches a named Server" data-testid="server-hop">
      <div style={hop}>
        <Reveal delay={160}>
          <Station eyebrow="01 · you" name="Your CLI" chip="token for this node" chipStyle={chipCarried}>
            You type a command with <code>--server staging</code>.
          </Station>
        </Reveal>
        <Wire delay={360} />
        <Reveal delay={480}>
          <Station eyebrow="02 · this node" name="This Server" chip="token for this node" chipStyle={chipDropped}>
            Looks up <code>staging</code> and answers with its address. The token stops here.
          </Station>
        </Reveal>
        <Wire delay={680} />
        <Reveal delay={800}>
          <Station eyebrow="03 · the name" name="staging" chip="its own credential, or none" chipStyle={chipFresh}>
            Receives the command straight from your CLI and decides for itself who you are.
          </Station>
        </Reveal>
      </div>
    </figure>
  );
}
