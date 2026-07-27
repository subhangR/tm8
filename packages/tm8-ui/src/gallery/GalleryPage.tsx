import type { CSSProperties, ReactNode } from 'react';
import type { EntitySummary } from '@tm8/contract';
import { Avatar, Chip, Eyebrow, HRule, IconBtn, Kbd, Pill, VRule, type PillTone } from '../kit';
import { fixtureSummaries, taskUuidTitle } from '../fixtures';

/**
 * DEV-ONLY kit gallery: every primitive, light and dark side by side.
 * The [data-theme] attribute here is a dev tool on a dev page — per
 * DECISIONS.md D1 no theme toggle appears in product shell chrome (theme's
 * one product home is the account menu, T3-3).
 */

/** Glyphs the canvases establish (T0-1 EDGE_IDS); others fall back to '·' —
 * the real kind registry is A1's job, not the gallery's. */
const CANVAS_GLYPHS: Partial<Record<string, string>> = {
  task: '◔', doc: '▤', pull_request: '⑂', work_session: '▣', team_member: '◇', channel: '◈',
};

const TONES: PillTone[] = ['run', 'wait', 'block', 'info', 'idle', 'brand'];

function Section({ title, children, row = true }: { title: string; children: ReactNode; row?: boolean }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Eyebrow>{title}</Eyebrow>
      <div style={{ display: 'flex', flexDirection: row ? 'row' : 'column', flexWrap: 'wrap', gap: 8, alignItems: row ? 'center' : 'stretch' }}>
        {children}
      </div>
    </section>
  );
}

function statusTone(s: EntitySummary): PillTone {
  if (s.deletedAt) return 'idle';
  if (s.kind === 'task' && s.state.kind === 'task') {
    const m: Record<string, PillTone> = { open: 'idle', pulled: 'idle', working: 'run', in_review: 'info', done: 'run', blocked: 'block', cancelled: 'idle' };
    return m[s.state.workStatus] ?? 'idle';
  }
  if (s.kind === 'work_session' && s.state.kind === 'work_session') {
    const m: Record<string, PillTone> = { spawning: 'wait', running: 'run', idle: 'idle', exited: 'idle', failed: 'block' };
    return m[s.state.status] ?? 'idle';
  }
  return 'idle';
}

function statusWord(s: EntitySummary): string {
  if (s.deletedAt) return 'deleted';
  if (s.state.kind === 'task') return s.state.workStatus;
  if (s.state.kind === 'work_session') return s.state.status;
  if (s.state.kind === 'pull_request') return s.state.stale ? 'stale' : s.state.state;
  return s.kind;
}

function FixtureStrip() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {fixtureSummaries.map((s) => (
        <div key={s.id} className="kit-hairline-b" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', minWidth: 0 }}>
          <span aria-hidden style={{ color: 'var(--pn-ink-3)', flex: 'none', fontSize: 12 }}>{CANVAS_GLYPHS[s.kind] ?? '·'}</span>
          <span
            className="t-body"
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textDecoration: s.deletedAt ? 'line-through' : undefined,
              color: s.deletedAt ? 'var(--pn-ink-4)' : undefined,
            }}
          >
            {s.title}
          </span>
          {s.badges.restricted ? <Pill tone="wait">restricted</Pill> : null}
          {s.badges.blocked ? <Pill tone="block">▲ {s.badges.blocked.unresolvedHardDependencyCount} blocked</Pill> : null}
          {(s.badges.pulls ?? []).some((p) => p.contentStale || p.discussionMoved) ? <Pill tone="wait">◌ delivery</Pill> : null}
          {(s.badges.workingActors ?? []).length > 0 ? <Pill tone="run" dot="pulse">live</Pill> : null}
          <Pill tone={statusTone(s)}>{statusWord(s)}</Pill>
          <Avatar provenance={s.createdBy.isAgent ? 'agent' : 'human'} label={s.createdBy.displayName} size={15} />
        </div>
      ))}
    </div>
  );
}

function ThemePane({ theme }: { theme: 'light' | 'dark' }) {
  const paneStyle: CSSProperties = { flex: 1, minWidth: 0, overflow: 'auto', padding: 24 };
  return (
    <div className="cv2-root" data-theme={theme === 'dark' ? 'dark' : undefined} style={paneStyle}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 560 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span className="t-h1">tm8-ui kit</span>
          <span className="t-eyebrow">{theme} · A0 GALLERY (DEV ONLY)</span>
        </div>

        <Section title="Type scale" row={false}>
          <span className="t-display">Display — Newsreader</span>
          <span className="t-h1">H1 — the editorial voice</span>
          <span className="t-h2">H2 — Hanken Grotesk</span>
          <span className="t-h3">H3 heading</span>
          <span className="t-title">Title 15</span>
          <span className="t-body">Body 14 — a calm instrument, not a dashboard.</span>
          <span className="t-secondary">Secondary 13</span>
          <span className="t-label">Label 12</span>
          <span className="t-eyebrow">Eyebrow micro</span>
          <span className="t-mono">mono 12.5 · JetBrains</span>
          <span className="t-code">t-code accent</span>
        </Section>

        <Section title="Pill · status = color + word">
          {TONES.map((t) => (
            <Pill key={t} tone={t}>{t}</Pill>
          ))}
          <Pill tone="run" dot="pulse">live</Pill>
          <Pill tone="run" dot="solid">done</Pill>
          <Pill outline>filter ▾</Pill>
          <Pill outline>↓ activity</Pill>
        </Section>

        <Section title="Eyebrow">
          <Eyebrow>Subtree · 2</Eyebrow>
          <Eyebrow faint>Runs · 1 live</Eyebrow>
        </Section>

        <Section title="Chip (Z1)">
          <Chip glyph="⑂">PR #212</Chip>
          <Chip glyph="▤">Layout spec</Chip>
          <Chip glyph="▣">forge</Chip>
          <Chip glyph="◔">{taskUuidTitle.title.slice(0, 12)}…</Chip>
        </Section>

        <Section title="IconBtn">
          <IconBtn label="Pin panel">⌗</IconBtn>
          <IconBtn label="Expand to full view">⇱</IconBtn>
          <IconBtn label="Copy id">⧉</IconBtn>
          <IconBtn label="Delete" danger>✕</IconBtn>
        </Section>

        <Section title="Kbd">
          <Kbd>/ palette · ⌘K</Kbd>
          <Kbd bare>esc</Kbd>
        </Section>

        <Section title="Avatar · shape is provenance">
          {([15, 20, 22, 32] as const).map((n) => (
            <Avatar key={`h${n}`} provenance="human" label="Ada" size={n} />
          ))}
          <VRule height={18} />
          {([15, 20, 22, 32] as const).map((n) => (
            <Avatar key={`a${n}`} provenance="agent" label="forge" size={n} />
          ))}
        </Section>

        <Section title="Hairline discipline" row={false}>
          <span className="t-secondary">1px line separators, never heavy dividers:</span>
          <HRule />
          <HRule strong />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 24 }}>
            <span className="t-secondary">left</span>
            <VRule height={18} />
            <span className="t-secondary">right</span>
          </div>
        </Section>

        <Section title="Fixture roster · every kind, every honesty state" row={false}>
          <FixtureStrip />
        </Section>
      </div>
    </div>
  );
}

export function GalleryPage() {
  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <ThemePane theme="light" />
      <ThemePane theme="dark" />
    </div>
  );
}
