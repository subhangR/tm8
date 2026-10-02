/**
 * CONTAINER — a machine an agent can run in or drive, as an entity.
 *
 * Signature moment: THE MACHINE AND ITS DOORS. The kind's own glyph, a divided
 * box, drawn large: on the left what the machine IS (profile, isolation), on
 * the right the doors into it arriving one by one, each labelled with the
 * command path that opens it. A reader leaves knowing there is no single
 * "connect" — there are seven different ways in, and each has its own rule.
 * Under reduced motion the whole box stands at once and reads as a table.
 *
 * Facts checked against this build: migration 177 (profiles, isolation
 * levels, the nine statuses and `container_transition_allowed`, the single
 * status writer, the five edge types and where each is written, `controls` as
 * the drive grant), the registry row (observed status, no board, `machine`
 * panel) and every `tm8 help container <verb>` note quoted below.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Reveal } from '../motion/Reveal';
import type { KindHelpModule } from '../types';

const box: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 0.8fr) minmax(0, 1.2fr)',
  margin: 'var(--pn-space-4) 0 var(--pn-space-2)',
  background: 'var(--eh-card)',
  border: '1px solid var(--eh-line)',
  borderRadius: 'var(--pn-r-md)',
  boxShadow: 'var(--pn-sh-md)',
  overflow: 'hidden',
};

const core: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--pn-space-3)',
  height: '100%',
  boxSizing: 'border-box',
  padding: 'var(--pn-space-4)',
  background: 'var(--eh-surface)',
  borderRight: '1px solid var(--eh-line)',
};

const glyph: CSSProperties = {
  fontSize: '44px',
  lineHeight: 1,
  color: 'var(--eh-brass)',
};

const label: CSSProperties = {
  fontFamily: 'var(--pn-mono)',
  fontSize: 'var(--pn-fs-fine)',
  letterSpacing: 'var(--pn-track-label)',
  textTransform: 'uppercase',
  color: 'var(--eh-ink-3)',
};

const chips: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '4px' };

const chip: CSSProperties = {
  fontFamily: 'var(--pn-mono)',
  fontSize: 'var(--pn-fs-fine)',
  padding: '1px 7px',
  borderRadius: 'var(--pn-r-pill)',
  border: '1px solid var(--eh-line)',
  background: 'var(--eh-card)',
  color: 'var(--eh-ink-2)',
};

const ladderStep = (rung: number): CSSProperties => ({
  ...chip,
  background: `color-mix(in srgb, var(--pn-info-soft) ${100 - rung * 18}%, var(--pn-run-soft))`,
  color: 'var(--eh-ink)',
});

const doors: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 'var(--pn-space-2) 0',
  display: 'flex',
  flexDirection: 'column',
};

const door: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '84px minmax(0, 1fr)',
  columnGap: 'var(--pn-space-3)',
  rowGap: '2px',
  alignItems: 'baseline',
  padding: '7px var(--pn-space-4)',
  borderLeft: '3px solid var(--eh-brass)',
  marginLeft: '-1px',
};

const doorName: CSSProperties = {
  gridRow: 'span 2',
  fontFamily: 'var(--pn-serif)',
  fontWeight: 600,
  fontSize: 'var(--pn-fs-sm)',
  color: 'var(--eh-ink)',
};

const doorPath: CSSProperties = { fontFamily: 'var(--pn-mono)', fontSize: 'var(--pn-fs-fine)', color: 'var(--eh-brass)' };

const doorNote: CSSProperties = {
  fontSize: 'var(--pn-fs-label)',
  lineHeight: 'var(--pn-lh-snug)',
  color: 'var(--eh-ink-2)',
};

const fixedNote: CSSProperties = {
  marginTop: 'auto',
  paddingTop: 'var(--pn-space-3)',
  borderTop: '1px dashed var(--eh-line)',
  fontSize: 'var(--pn-fs-label)',
  lineHeight: 'var(--pn-lh-snug)',
  color: 'var(--eh-ink-3)',
};

const PROFILES = ['shell', 'desktop', 'browser', 'android', 'ios', 'dind', 'custom'];
const ISOLATION = ['process', 'container', 'gvisor', 'microvm', 'vm'];

const DOORS: readonly { name: string; path: string; note: ReactNode }[] = [
  { name: 'Run', path: 'tm8 container run', note: 'One command, its output back. The argv after -- is never parsed by the CLI.' },
  { name: 'Terminal', path: 'tm8 container terminal', note: 'A PTY in the image’s login shell, opened as a work session you attach to.' },
  { name: 'Screen', path: 'tm8 container attach', note: 'A fresh grant for screen, browser, adb or docker, to view or to drive.' },
  { name: 'Computer', path: 'tm8 container computer', note: 'One click, key or scroll, and a screenshot back. Same words for desktop, browser and android.' },
  { name: 'Browser', path: 'tm8 container browser', note: 'A CDP endpoint for a browser machine, or goto and text in one line.' },
  { name: 'Ports', path: 'tm8 container expose', note: 'A port published through the node, shared with nobody, the Space, or a link.' },
  { name: 'Files', path: 'tm8 container cp', note: 'A tar stream in or out. The ctr: prefix says which side is the machine.' },
];

/** THE MACHINE AND ITS DOORS — the signature moment. */
function MachineAndDoors() {
  return (
    <figure style={{ margin: 0 }} aria-label="A container and the doors into it" data-testid="container-doors">
      <div style={box}>
        <Reveal delay={120}>
          <div style={core}>
            <span style={glyph} aria-hidden>
              ◫
            </span>
            <span style={label}>What it is · profile</span>
            <span style={chips}>
              {PROFILES.map((name) => (
                <span key={name} style={chip}>
                  {name}
                </span>
              ))}
            </span>
            <span style={label}>How walled off · isolation</span>
            <span style={chips}>
              {ISOLATION.map((name, rung) => (
                <span key={name} style={ladderStep(rung)}>
                  {name}
                </span>
              ))}
            </span>
            <span style={fixedNote}>
              CPU, memory and mounts are fixed at create. A machine that needs different hardware is a new machine.
            </span>
          </div>
        </Reveal>
        <ul style={doors} aria-label="Doors into the machine">
          {DOORS.map((d, index) => (
            <Reveal key={d.name} as="li" delay={380 + index * 150}>
              <span style={door}>
                <span style={doorName}>{d.name}</span>
                <code style={doorPath}>{d.path}</code>
                <span style={doorNote}>{d.note}</span>
              </span>
            </Reveal>
          ))}
        </ul>
      </div>
    </figure>
  );
}

export const CONTAINER_HELP: KindHelpModule = {
  kind: 'container',
  story: {
    logline: 'A container is a machine an agent is allowed to break, with its own walls and a named door for every way in.',
    opening: (
      <>
        <p>
          A <strong>container</strong> is a computer your agents can use: a shell, a desktop, a browser, a phone
          emulator, or a machine that runs its own containers. It has a screen you can watch, a terminal you can open
          and ports you can publish. It is also an entity, with a title, a version and a place in the graph, so it
          shows up in lists, carries a discussion and answers to the same permissions as everything else.
        </p>
        <p>
          Without it, an agent that needs a browser or a clean Linux box borrows the host it runs on, and that work
          has no record of its own. A container gives that work its own walls, and it makes every way in something you
          ask for by name.
        </p>
      </>
    ),
    beats: [
      {
        eyebrow: 'The signature',
        title: 'One machine, seven doors',
        body: (
          <>
            <p>
              There is no single &ldquo;connect&rdquo;. Each way into a machine is its own verb with its own rule.
              Screens and browsers are reached with a grant minted fresh on every call, and a terminal is a work
              session of its own.
            </p>
            <MachineAndDoors />
          </>
        ),
      },
      {
        eyebrow: 'How it is born',
        title: 'Created by its own verb, and started by default',
        body: (
          <p>
            <code>tm8 container create</code> takes a profile and is the only way to make one. A generic{' '}
            <code>tm8 entity create</code> is refused, because a machine without a provider behind it would be a
            record of nothing. Creation starts the machine unless you pass <code>--no-start</code>. CPU, memory and
            mounts are fixed at birth, so a machine that needs different hardware is a new machine. <code>--env</code>{' '}
            refuses keys that look like credentials, and a mount&rsquo;s host path is never shown back.
          </p>
        ),
      },
      {
        eyebrow: 'The rule',
        title: 'Its status is observed, never set',
        body: (
          <p>
            A container&rsquo;s status has exactly one writer on the server, which reports what the provider says. Nobody
            can drag it into a column, which is why containers have no board view. From <em>destroying</em> or{' '}
            <em>failed</em> there is no road back to running, and <em>destroyed</em> is final: nothing leaves it. Every
            teardown passes through <em>destroying</em>, so the provider call always has a state to be seen in.
          </p>
        ),
      },
      {
        eyebrow: 'Who may drive',
        title: 'Watching is not driving',
        body: (
          <p>
            A surface opens to <em>view</em> or to <em>drive</em>. Driving belongs to the creator, or to a member or
            teammate the creator named with a <code>controls</code> edge. A grant token travels only inside the
            websocket subprotocol, never in a URL. The one exception is a browser&rsquo;s CDP endpoint, because CDP
            clients cannot send a subprotocol.
          </p>
        ),
      },
      {
        eyebrow: 'How it ends',
        title: 'Destroyed on purpose, or kept as a template',
        body: (
          <p>
            <code>tm8 container destroy</code> takes the version you last read, and that version is the deliberate
            act. <code>--force</code> changes how the machine stops, never who may stop it. Before that, a machine
            worth keeping can be snapshotted into a template that others are forked and pooled from. The fork remembers
            where it came from through a <code>snapshot_of</code> edge.
          </p>
        ),
      },
    ],
    lifecycle: [
      { name: 'Requested', note: 'The record exists, and the node has been asked for a machine.' },
      { name: 'Provisioning', note: 'The provider is building it. Failure here lands in failed.' },
      { name: 'Running', note: 'Doors open. Pause freezes it without releasing memory, where the provider can.' },
      { name: 'Stopped', note: 'The record stays. Start brings it straight back to running.' },
      { name: 'Destroying', note: 'Reachable from any state but destroyed. The provider tears the runtime down.' },
      { name: 'Destroyed', note: 'Final. The record and its edges stay for history. The machine is gone.' },
    ],
  },

  toolkit: {
    intro: (
      <p>
        Every lifecycle verb carries <code>--expect-version</code>, so read the machine before you change it. The
        machine&rsquo;s own truth, meaning its logs and which providers exist, lives on the node rather than in the
        graph, and two reads go there directly. A node with containers switched off answers the whole family with an
        honest not-implemented, so ask what the node can run before anything else.
      </p>
    ),
    scenes: [
      {
        title: 'Ask the node, then make a machine',
        narrative: (
          <p>
            <code>tm8 container providers</code> reports what this node can actually run. Its probe verdict comes
            from really creating and destroying a container, not from finding a binary on the PATH. Then{' '}
            <code>tm8 container create</code> with a profile. Network is a preset, open, balanced or locked, plus an
            allowlist, and <code>tm8 container policy</code> changes it later.
          </p>
        ),
        commands: ['container providers', 'container create', 'container policy'],
        demo: [
          '# what can this node run?',
          'tm8 container providers',
          '# a browser that may only reach one host',
          'tm8 container create browser --network locked --allow <hostname>',
        ],
      },
      {
        title: 'Work inside it',
        narrative: (
          <p>
            <code>tm8 container run</code> is one command with its output returned. Output past 64 KiB is cut from
            the recorded result, and the whole of it stays in <code>tm8 container logs</code> for 24 hours. For a
            conversation with the shell, <code>tm8 container terminal</code> opens a PTY as a work session. Files move
            with <code>tm8 container cp</code>.
          </p>
        ),
        commands: ['container run', 'container logs', 'container terminal', 'container cp'],
        demo: [
          'tm8 container run <container-id> -- ls -la /workspace',
          '# the full output of a long run',
          'tm8 container logs <container-id> --tail 200',
        ],
      },
      {
        title: 'Drive its screen',
        narrative: (
          <p>
            <code>tm8 container computer</code> performs one action and returns a screenshot. Coordinates are in the
            pixels of the last screenshot, and the node keeps the mapping. Pass <code>--keep</code> to store the
            screenshot on the container as an artifact revision, which is the record a reviewer reads later.
          </p>
        ),
        commands: ['container computer', 'container screenshot', 'container browser', 'container attach'],
        demo: [
          'tm8 container screenshot <container-id>',
          'tm8 container computer <container-id> click --x <n> --y <n>',
        ],
      },
      {
        title: 'Pause, keep, clone, retire',
        narrative: (
          <p>
            Pause is refused by a provider that cannot pause, rather than faked with a stop.{' '}
            <code>tm8 container snapshot</code> captures the disk, and <code>--make-template</code> turns it into a
            base. <code>tm8 container fork</code> needs no version because it only reads the source.{' '}
            <code>tm8 container pool</code> keeps up to eight machines warm from a template.
          </p>
        ),
        commands: [
          'container pause',
          'container resume',
          'container stop',
          'container start',
          'container snapshot',
          'container fork',
          'container pool',
          'container destroy',
        ],
      },
    ],
  },

  constellation: {
    intro: (
      <p>
        A container sits among the sessions that use it. A work session <em>runs in</em> a machine when its processes
        live there, and <em>drives</em> one when it reaches in through tools. Look for those two edges first: they
        answer who did what on this machine. After them come the project it mounts and the template it was forked
        from.
      </p>
    ),
    notes: {
      'runs_in:incoming': 'A terminal opened on this machine is a work session whose processes run in it.',
      'drives:incoming': 'A session that uses this machine through its tools, run, computer or attach. Only within its own Space.',
      'controls:incoming': 'The creator’s grant to drive a surface, not only view it. Without it, only the creator drives.',
      'mounts:outgoing': 'The project’s working directory, bind-mounted in when the machine was created with a project.',
      'snapshot_of:outgoing': 'The snapshot or template this machine was forked from. Acyclic, so lineage always ends.',
      'snapshot_of:incoming': 'Machines forked from this one, when it is a snapshot or a template.',
    },
    spotlight: ['work_session', 'project', 'member', 'team_member'],
  },
};
