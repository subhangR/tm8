import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './kit/kit.css';
import { VectorIcon } from './kit';
import { KIND_ART, SURFACE_ART, VIEW_ART, allKinds, type KindArt } from './domain';
import { RAIL_USER_ART } from './tab-workspace/view/railArt';

/**
 * ICON CONTACT SHEET (task 01a14b26) — every kind mark, every rail view mark,
 * every session surface mark, and every chat-like glyph drawn OUTSIDE the
 * shared tables, at 14 / 16 / 18px, light and dark.
 *
 * `?sheet=current` draws what ships; `?sheet=proposed` applies `PROPOSED`;
 * `?sheet=pairs` puts each confusable pair before and after side by side.
 */

/** Chat/kind-like glyphs drawn inline instead of through the shared tables. */
const STRAYS: { label: string; where: string; art: KindArt }[] = [
  { label: 'Chat button', where: 'ActionStrip.tsx:262', art: ['M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z'] },
  { label: 'Messages button', where: 'ActionStrip.tsx:366', art: ['M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z M5 6h6M5 8h4'] },
  {
    label: 'Chats row (phone)',
    where: 'MobileDrawer.tsx:159',
    art: ['M13.2 9.4a1.6 1.6 0 0 1-1.6 1.6H6l-3 2.4V4.2a1.6 1.6 0 0 1 1.6-1.6h7a1.6 1.6 0 0 1 1.6 1.6z'],
  },
  { label: 'Links button', where: 'ActionStrip.tsx:356', art: ['M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8'] },
  { label: 'Connectors button', where: 'ActionStrip.tsx:501', art: ['M6 1.5v3M10 1.5v3M4 4.5h8v3a4 4 0 0 1-8 0zM8 11.5v3'] },
  { label: 'Account (rail)', where: 'railArt.ts RAIL_USER_ART', art: RAIL_USER_ART },
  {
    label: 'Account (phone)',
    where: 'MobileDrawer.tsx:176',
    art: ['M8 8.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8', 'M3.4 13.2a4.6 4.6 0 0 1 9.2 0'],
  },
];

/** Text glyphs that stand in for a chat mark today (no art at all). */
const TEXT_STRAYS = [
  { label: '"Chat" verb, every detail header', where: "actions.ts 'chat-about' icon", glyph: '❝' },
  { label: 'Messages row text fallback', where: 'menu-resolve.ts:306', glyph: '✉' },
];

/* ---------------------------------------------------------------- proposal */

/** ONE chat mark: two bubbles, front one with a tail, back one peeking out. */
const CHAT: KindArt = [
  'M2.4 3.8a1.4 1.4 0 0 1 1.4-1.4h5.6a1.4 1.4 0 0 1 1.4 1.4v3.6a1.4 1.4 0 0 1-1.4 1.4H5.4L2.4 11.2z',
  'M10.8 5.6h1.4a1.4 1.4 0 0 1 1.4 1.4v6.6l-2.4-2H7a1.4 1.4 0 0 1-1.4-1.4v-.6',
];
/** A message is a letter: an envelope. Nothing bubble-shaped. */
const MESSAGE: KindArt = [
  'M3.8 3.6h8.4a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.8a1.4 1.4 0 0 1-1.4-1.4V5a1.4 1.4 0 0 1 1.4-1.4z',
  'M2.8 4.6 8 8.4l5.2-3.8',
];
/** A skill is something LEARNED: a mortarboard. No book, so no story collision. */
const SKILL: KindArt = [
  'M8 3 14 6 8 9 2 6z',
  'M4.6 7.3v3.1c0 .9 1.5 1.9 3.4 1.9s3.4-1 3.4-1.9V7.3',
  'M14 6v3.6',
];
/** A craft is stacked pages: layers. Was two sheets, the worktree silhouette. */
const CRAFT: KindArt = ['M8 2.6 13.4 5.4 8 8.2 2.6 5.4z', 'M2.6 8 8 10.8 13.4 8', 'M2.6 10.6 8 13.4l5.4-2.8'];
/** A blueprint is a flowchart: two boxes and an elbow. Was the PR mark mirrored. */
const GRAPH: KindArt = ['M2.4 2.6h5v4h-5z', 'M8.6 9.4h5v4h-5z', 'M4.9 6.6v3.8a1 1 0 0 0 1 1h2.7'];
/** A space link exchanges with another space: two-way arrows. Was the Links chain. */
const SPACE_LINK: KindArt = ['M2.8 5.6h10.4', 'M10.6 3 13.2 5.6 10.6 8.2', 'M13.2 10.4H2.8', 'M5.4 7.8 2.8 10.4 5.4 13'];
/** A transcript is a dialogue written down: lines alternating sides. No bubble. */
const TRANSCRIPT: KindArt = ['M2.6 4h6.4', 'M2.6 6.6h4.4', 'M7 9.4h6.4', 'M9 12h4.4'];
/** The Files explorer is a TREE of files, not a second folder beside `project`. */
const FILES: KindArt = ['M3.2 2.8h3.2', 'M4.4 2.8v8.6h3.2', 'M4.4 7.2h3.2', 'M7.6 6h5v2.4h-5z', 'M7.6 10.2h5v2.4h-5z'];

const PROPOSED_KIND: Partial<Record<keyof typeof KIND_ART, KindArt>> = {
  chat: CHAT,
  message: MESSAGE,
  skill: SKILL,
  craft: CRAFT,
  graph: GRAPH,
  space_link: SPACE_LINK,
};
const PROPOSED_VIEW: Partial<Record<keyof typeof VIEW_ART, KindArt>> = {
  messages: MESSAGE,
  craft: CRAFT,
  files: FILES,
};
const PROPOSED_SURFACE: Partial<Record<keyof typeof SURFACE_ART, KindArt>> = { transcript: TRANSCRIPT };
const PROPOSED_STRAY: Record<string, KindArt> = {
  'Chat button': CHAT,
  'Messages button': MESSAGE,
  'Chats row (phone)': CHAT,
  'Connectors button': KIND_ART.mcp_server,
  'Account (rail)': KIND_ART.member,
  'Account (phone)': KIND_ART.member,
};

const PAIRS: { name: string; a: [string, KindArt, KindArt]; b: [string, KindArt, KindArt] }[] = [
  { name: 'message vs chat', a: ['message', KIND_ART.message, MESSAGE], b: ['chat', KIND_ART.chat, CHAT] },
  { name: 'Messages view vs chat', a: ['Messages view', VIEW_ART.messages, MESSAGE], b: ['chat', KIND_ART.chat, CHAT] },
  { name: 'transcript vs message', a: ['transcript', SURFACE_ART.transcript, TRANSCRIPT], b: ['message', KIND_ART.message, MESSAGE] },
  { name: 'phone Chats vs message', a: ['phone Chats', STRAYS[2]!.art, CHAT], b: ['message', KIND_ART.message, MESSAGE] },
  { name: 'skill vs story', a: ['skill', KIND_ART.skill, SKILL], b: ['story', KIND_ART.story, KIND_ART.story] },
  { name: 'craft vs worktree', a: ['craft', KIND_ART.craft, CRAFT], b: ['worktree', KIND_ART.worktree, KIND_ART.worktree] },
  { name: 'graph vs pull request', a: ['graph', KIND_ART.graph, GRAPH], b: ['pull_request', KIND_ART.pull_request, KIND_ART.pull_request] },
  { name: 'space link vs Links', a: ['space_link', KIND_ART.space_link, SPACE_LINK], b: ['Links button', STRAYS[3]!.art, STRAYS[3]!.art] },
  { name: 'Craft view vs drawing', a: ['Craft view', VIEW_ART.craft, CRAFT], b: ['drawing', KIND_ART.drawing, KIND_ART.drawing] },
  { name: 'File browser vs project', a: ['File browser', VIEW_ART.files, FILES], b: ['project', KIND_ART.project, KIND_ART.project] },
];

/* ------------------------------------------------------------------ render */

type Row = { label: string; note?: string; art: KindArt; changed?: boolean };
const SIZES = [14, 16, 18] as const;

function Marks({ art }: { art: KindArt }) {
  return (
    <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
      {SIZES.map((s) => (
        <VectorIcon key={s} paths={art} size={s} />
      ))}
    </span>
  );
}

function Grid({ rows }: { rows: Row[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '4px 18px' }}>
      {rows.map((row) => (
        <div
          key={row.label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '3px 6px',
            borderRadius: 6,
            outline: row.changed ? '1.5px solid var(--pn-wait)' : 'none',
          }}
        >
          <Marks art={row.art} />
          <span style={{ fontSize: 12, lineHeight: 1.2 }}>
            {row.label}
            {row.note ? <span style={{ color: 'var(--pn-ink-3)', fontSize: 10.5 }}> · {row.note}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function Themed({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0 }}>
      {(['light', 'dark'] as const).map((theme) => (
        <div
          key={theme}
          className="cv2-root"
          data-theme={theme}
          style={{ background: 'var(--pn-card)', color: 'var(--pn-ink)', padding: '14px 16px' }}
        >
          <div style={{ fontSize: 10.5, color: 'var(--pn-ink-3)', marginBottom: 8 }}>{theme} · 14 / 16 / 18px</div>
          {children}
        </div>
      ))}
    </div>
  );
}

function Section({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section style={{ marginBottom: 14 }}>
      <h2 style={{ font: '600 13px system-ui', margin: '0 0 6px' }}>{title}</h2>
      <Themed>
        <Grid rows={rows} />
      </Themed>
    </section>
  );
}

function Sheet({ proposed }: { proposed: boolean }) {
  const kinds: Row[] = allKinds().map((k) => {
    const next = proposed ? PROPOSED_KIND[k.kind as keyof typeof KIND_ART] : undefined;
    return { label: k.label, note: k.kind, art: next ?? k.iconArt, changed: Boolean(next) };
  });
  const views: Row[] = Object.entries(VIEW_ART).map(([key, art]) => {
    const next = proposed ? PROPOSED_VIEW[key as keyof typeof VIEW_ART] : undefined;
    return { label: key, art: next ?? art, changed: Boolean(next) };
  });
  const surfaces: Row[] = Object.entries(SURFACE_ART).map(([key, art]) => {
    const next = proposed ? PROPOSED_SURFACE[key as keyof typeof SURFACE_ART] : undefined;
    return { label: key, art: next ?? art, changed: Boolean(next) };
  });
  const strays: Row[] = STRAYS.map((s) => {
    const next = proposed ? PROPOSED_STRAY[s.label] : undefined;
    return { label: s.label, note: next ? 'shared table' : s.where, art: next ?? s.art, changed: Boolean(next) };
  });
  return (
    <div style={{ padding: 16, font: '12px system-ui', width: 1500 }}>
      <h1 style={{ font: '700 16px system-ui', margin: '0 0 10px' }}>
        {proposed ? 'PROPOSED icon set (changed marks outlined)' : 'CURRENT icon set'}
      </h1>
      <Section title={`Entity kinds (${kinds.length})`} rows={kinds} />
      <Section title="Rail views (VIEW_ART)" rows={views} />
      <Section title="Session surfaces (SURFACE_ART)" rows={surfaces} />
      <Section title={proposed ? 'Glyphs that were drawn inline, now read from the shared table' : 'Glyphs drawn inline, outside the shared tables'} rows={strays} />
      {proposed ? null : (
        <section>
          <h2 style={{ font: '600 13px system-ui', margin: '0 0 6px' }}>Text glyphs standing in for a mark</h2>
          {TEXT_STRAYS.map((t) => (
            <div key={t.label} style={{ fontSize: 12 }}>
              <span style={{ fontSize: 16, marginRight: 8 }}>{t.glyph}</span>
              {t.label} <span style={{ color: 'var(--pn-ink-3)' }}>· {t.where}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Pairs() {
  const cell = (art: KindArt) => <Marks art={art} />;
  return (
    <div style={{ padding: 16, font: '12px system-ui', width: 1100 }}>
      <h1 style={{ font: '700 16px system-ui', margin: '0 0 10px' }}>Confusable pairs, before → after</h1>
      <Themed>
        <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {PAIRS.map((p) => (
              <tr key={p.name} style={{ borderBottom: '1px solid var(--pn-line)' }}>
                <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>{p.name}</td>
                <td style={{ padding: '6px 8px' }}>{cell(p.a[1])}</td>
                <td style={{ padding: '6px 8px' }}>{cell(p.b[1])}</td>
                <td style={{ padding: '6px 8px', color: 'var(--pn-ink-3)' }}>→</td>
                <td style={{ padding: '6px 8px' }}>{cell(p.a[2])}</td>
                <td style={{ padding: '6px 8px' }}>{cell(p.b[2])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Themed>
    </div>
  );
}

const sheet = new URLSearchParams(location.search).get('sheet') ?? 'current';
createRoot(document.getElementById('root')!).render(
  sheet === 'pairs' ? <Pairs /> : <Sheet proposed={sheet === 'proposed'} />,
);
