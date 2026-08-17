import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/canvas-extra.css';
import './styles/app.css';
import './kit/kit.css';
import { BootLoader, BrandMark, type RibbonMotion } from './kit';

/**
 * BOOT LOADER SCRATCH HARNESS — same spirit as terminal-dev.tsx and
 * artifact-dev.tsx: a gate-free mount for pixel-verifying ONE surface.
 *
 * This one earns its keep more than most. The mark is 150 shaded polygons
 * computed per frame from a 3D Möbius frame, and jsdom rasterizes nothing, so
 * `ribbon-mark.test.tsx` can only prove the numbers are finite and inside the
 * box — it cannot tell a figure-8 from a knot, a smear, or a mark whose near
 * and far halves sort the wrong way round. The only instrument that can is a
 * browser looking at it, and this is the cheapest way to point one at it
 * without a node, credentials, or the boot gate it normally lives behind.
 *
 * Both authored motion variants are mounted side by side because the choice
 * between them is still open, and on both grounds because brass is the one ink
 * that has to hold on each.
 *
 * Usage: /loader-dev.html
 */
/* Tokens, not literals: the package bans inline hex (hex-ban.test.ts §14), and
   reading `--pn-paper` / `--pn-ink` is also what makes the two halves below
   genuinely show the two themes rather than two hardcoded guesses at them. */
function Panel({ motion, label }: { motion: RibbonMotion; label: string }) {
  return (
    <div style={{ background: 'var(--pn-paper)', padding: '32px 24px', flex: 1 }}>
      <p
        style={{
          font: '600 11px ui-monospace,monospace',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--pn-ink)',
          margin: '0 0 8px',
          textAlign: 'center',
        }}
      >
        {label}
      </p>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <BootLoader label="loading workspace" motion={motion} />
      </div>
    </div>
  );
}

/* The brand line at the sizes it actually ships at, so the wordmark can be
   checked where it is small — 11.5px in the tab bar is where a mis-set ribbon
   stops reading as an 8, and the boot panels above are far too generous to
   show that. */
function BrandLine({ size, where }: { size: number; where: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0' }}>
      <span
        style={{
          font: `600 ${size}px var(--pn-mono)`,
          color: 'var(--pn-brand)',
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        <BrandMark />
      </span>
      <span style={{ font: '400 10px var(--pn-mono)', color: 'var(--pn-ink-4)' }}>
        {size}px · {where}
      </span>
    </div>
  );
}

function Row({ theme }: { theme?: 'dark' }) {
  return (
    <div
      className="cv2-root"
      data-theme={theme}
      style={{ background: 'var(--pn-paper)', padding: '0 0 24px' }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap' }}>
        <Panel motion="spin-rewind" label={`${theme ?? 'light'} · spin-rewind`} />
        <Panel motion="clock-counter" label={`${theme ?? 'light'} · clock-counter`} />
      </div>
      <div style={{ padding: '0 24px' }}>
        <BrandLine size={11.5} where="shell tab bar" />
        <BrandLine size={13} where="auth / invite stage" />
        <BrandLine size={22} where="oversize, for reading the join" />
      </div>
    </div>
  );
}

function Harness() {
  return (
    <div style={{ minHeight: '100vh' }}>
      <Row />
      <Row theme="dark" />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
