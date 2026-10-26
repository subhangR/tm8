import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './kit/kit.css';
import { VectorIcon } from './kit';
import { SURFACE_ART, VIEW_ART, allKinds, resolveAction, type KindArt } from './domain';

/**
 * ICON CONTACT SHEET (task 01a14b26) — every kind mark, every rail view mark,
 * every session surface mark and every verb with drawn art, at 14 / 16 / 18px,
 * light and dark. Open it when changing `domain/kind-art.ts`: two marks that
 * converge are found here by eye, where `kind-art.test.ts` can only say they
 * are not byte-identical.
 */

type Row = { label: string; note?: string; art: KindArt };
const SIZES = [14, 16, 18] as const;

function Grid({ rows }: { rows: Row[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '4px 18px' }}>
      {rows.map((row) => (
        <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 6px' }}>
          <span style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
            {SIZES.map((s) => (
              <VectorIcon key={s} paths={row.art} size={s} />
            ))}
          </span>
          <span style={{ fontSize: 12, lineHeight: 1.2 }}>
            {row.label}
            {row.note ? <span style={{ color: 'var(--pn-ink-3)', fontSize: 10.5 }}> · {row.note}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

function Themed({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
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

function Sheet() {
  const kinds = allKinds().map((k) => ({ label: k.label, note: k.kind, art: k.iconArt }));
  const views = Object.entries(VIEW_ART).map(([key, art]) => ({ label: key, art }));
  const surfaces = Object.entries(SURFACE_ART).map(([key, art]) => ({ label: key, art }));
  const chat = resolveAction('chat-about');
  const verbs = chat.art ? [{ label: chat.label, note: 'chat-about verb', art: chat.art }] : [];
  return (
    <div style={{ padding: 16, font: '12px system-ui', width: 1500 }}>
      <h1 style={{ font: '700 16px system-ui', margin: '0 0 10px' }}>Icon contact sheet</h1>
      <Section title={`Entity kinds (${kinds.length})`} rows={kinds} />
      <Section title="Rail views (VIEW_ART)" rows={views} />
      <Section title="Session surfaces (SURFACE_ART)" rows={surfaces} />
      <Section title="Verbs with drawn art" rows={verbs} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Sheet />);
