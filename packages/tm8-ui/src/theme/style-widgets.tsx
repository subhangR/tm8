/**
 * THE EDITOR'S KIND WIDGETS (styles spec v8 §2 "editor widget" column, §9.2
 * Widgets, phase 4). One widget per registry KIND, chosen from the registry
 * entry — no key is hand-listed here, so a key a release adds gets its widget
 * for free:
 *
 *   colour            swatch → picker (saturation/value, hue, alpha where the
 *                     foundation value carries alpha) + text
 *   length/ratio/
 *   number/duration   stepper with the entry's unit and range; `auto` toggle
 *                     where the entry lists it; unparseable values keep text
 *   font              dropdown of bundled + system (+ installed, where the
 *                     browser can list them) stacks + text
 *   shadow            text with a live swatch
 *   easing            dropdown of keywords and curves + text, with the curve
 *   enum              dropdown
 *
 * Plus the composite views: the ANSI 16-cell grid, an xterm sample painted
 * through LiveTerminal's own theme mapping, and the contrast strip (the same
 * pairs the resolver lints; it informs and never blocks Save or Push).
 *
 * Every value a widget emits is a string the per-key grammar accepts
 * (`validateStyleVar`); anything it cannot represent stays in the text field.
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import {
  cssNumber,
  styleContrastChecks,
  type ResolvedStyle,
  type StyleRegistryEntry,
  type StyleTokenTable,
} from '@tm8/contract';

import { buildTerminalTheme, terminalStyleOptions } from '../terminal/terminalTheme';
import './style-widgets.css';

export type SetVar = (key: string, value: string | null) => void;

// ── colour maths ───────────────────────────────────────────────────────────

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `#rgb[a]`, `#rrggbb[aa]`, `rgb()`/`rgba()` (comma or space syntax, `/ a`); null otherwise. */
export function parseRgba(value: string | undefined): Rgba | null {
  const v = (value ?? '').trim();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v)?.[1];
  if (hex) {
    const long = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const n = (i: number) => parseInt(long.slice(i * 2, i * 2 + 2), 16);
    return { r: n(0), g: n(1), b: n(2), a: long.length === 8 ? Math.round((n(3) / 255) * 100) / 100 : 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (!fn) return null;
  const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? Number(fn[4].slice(0, -1)) / 100 : Number(fn[4]);
  const c = [fn[1], fn[2], fn[3]].map((x) => Math.min(255, Math.round(Number(x))));
  if (!c.every(Number.isFinite) || !Number.isFinite(alpha)) return null;
  return { r: c[0]!, g: c[1]!, b: c[2]!, a: Math.min(1, Math.max(0, alpha)) };
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0');

export function rgbHex({ r, g, b }: Rgba): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** Opaque → `#rrggbb`; translucent → `rgba(r, g, b, a)` — the forms the built-ins use. */
export function formatRgba(c: Rgba): string {
  const a = Math.round(c.a * 100) / 100;
  return a >= 1 ? rgbHex(c) : `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${cssNumber(a)})`;
}

interface Hsv {
  h: number;
  s: number;
  v: number;
}

function rgbToHsv({ r, g, b }: Rgba): Hsv {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function hsvToRgb({ h, s, v }: Hsv, a: number): Rgba {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return { r: f(5), g: f(3), b: f(1), a };
}

// ── colour ─────────────────────────────────────────────────────────────────

interface ColourProps {
  entry: StyleRegistryEntry;
  /** The doc's own value, undefined when inherited. */
  value: string | undefined;
  /** The foundation's value. */
  inherited: string;
  /** What actually paints (one-hop `var()` resolved), for the swatch and the picker's start. */
  painted: string;
  setVar?: SetVar;
  /** Grid cells show only the swatch; rows add the text field. */
  compact?: boolean;
  label?: string;
}

export function ColourWidget({ entry, value, inherited, painted, setVar, compact, label }: ColourProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const key = entry.key;
  /* Alpha is offered where the key is translucent in its foundation (the
     -soft ramps, scrim, selection) or the author already made it so. */
  const allowAlpha = (parseRgba(inherited)?.a ?? 1) < 1 || (parseRgba(value)?.a ?? 1) < 1;
  return (
    <span className="stylew__colour" ref={wrap}>
      <button
        type="button"
        className="styleed__swatch stylew__swatchbtn"
        style={{ background: painted }}
        aria-label={`${label ?? key} colour`}
        title={label ? `${label}: ${painted}` : painted}
        aria-expanded={open}
        disabled={!setVar}
        onClick={() => setOpen((v) => !v)}
      />
      {open && setVar ? (
        <ColourPopover
          start={parseRgba(painted) ?? parseRgba(inherited) ?? { r: 128, g: 128, b: 128, a: 1 }}
          allowAlpha={allowAlpha}
          isSet={value !== undefined}
          onPick={(c) => setVar(key, formatRgba(c))}
          onReset={() => setVar(key, null)}
          within={wrap}
          onClose={() => setOpen(false)}
        />
      ) : null}
      {!compact && setVar ? (
        <input
          className="styleed__input"
          value={value ?? ''}
          placeholder={inherited}
          aria-label={key}
          spellCheck={false}
          onChange={(e) => setVar(key, e.target.value === '' ? null : e.target.value)}
        />
      ) : null}
      {!compact && !setVar ? <code className="styleed__varval">{value ?? inherited}</code> : null}
    </span>
  );
}

interface EyeDropperLike {
  open: () => Promise<{ sRGBHex: string }>;
}

function ColourPopover({
  start,
  allowAlpha,
  isSet,
  onPick,
  onReset,
  within,
  onClose,
}: {
  start: Rgba;
  allowAlpha: boolean;
  isSet: boolean;
  onPick: (c: Rgba) => void;
  onReset: () => void;
  /** Clicks inside this (the popover and its swatch) do not close it. */
  within: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(start));
  const [alpha, setAlpha] = useState(start.a);
  const [hexText, setHexText] = useState(() => rgbHex(start));
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (within.current && !within.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [within, onClose]);

  const emit = (next: Hsv, a: number) => {
    setHsv(next);
    setAlpha(a);
    const c = hsvToRgb(next, a);
    setHexText(rgbHex(c));
    onPick(c);
  };

  const onPlane = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointermove' && e.buttons !== 1) return;
    const box = e.currentTarget.getBoundingClientRect();
    const s = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const v = 1 - Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    emit({ ...hsv, s, v }, alpha);
  };

  const dropper = (window as unknown as { EyeDropper?: new () => EyeDropperLike }).EyeDropper;
  const opaque = hsvToRgb(hsv, 1);

  return (
    <div className="stylew__popover" role="dialog" aria-label="colour picker">
      <div
        className="stylew__plane"
        style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          onPlane(e);
        }}
        onPointerMove={onPlane}
        data-testid="colour-plane"
      >
        <span className="stylew__thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <input
        type="range"
        className="stylew__hue"
        min={0}
        max={359}
        value={Math.round(hsv.h)}
        aria-label="hue"
        onChange={(e) => emit({ ...hsv, h: Number(e.target.value) }, alpha)}
      />
      {allowAlpha ? (
        <input
          type="range"
          className="stylew__alpha"
          style={{ ['--stylew-opaque' as string]: rgbHex(opaque) }}
          min={0}
          max={1}
          step={0.01}
          value={alpha}
          aria-label="alpha"
          onChange={(e) => emit(hsv, Number(e.target.value))}
        />
      ) : null}
      <div className="stylew__poprow">
        <input
          className="styleed__input stylew__hex"
          value={hexText}
          aria-label="hex"
          spellCheck={false}
          onChange={(e) => {
            setHexText(e.target.value);
            const c = parseRgba(e.target.value);
            if (c) emit(rgbToHsv(c), allowAlpha && c.a < 1 ? c.a : alpha);
          }}
        />
        {allowAlpha ? <output className="stylew__alphaout">{Math.round(alpha * 100)}%</output> : null}
        {dropper ? (
          <button
            type="button"
            className="styleed__link"
            title="Pick a colour from the screen"
            onClick={() => {
              void new dropper()
                .open()
                .then((r) => {
                  const c = parseRgba(r.sRGBHex);
                  if (c) emit(rgbToHsv(c), alpha);
                })
                .catch(() => {});
            }}
          >
            Pick
          </button>
        ) : null}
        {isSet ? (
          <button type="button" className="styleed__link" onClick={onReset}>
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── steppers ───────────────────────────────────────────────────────────────

/** The step a key moves by, from its unit and range: fine for em and ratios, coarse for scrollback. */
export function stepFor(entry: StyleRegistryEntry): number {
  if (entry.unit === 'em') return 0.01;
  if (entry.unit === 'ms') return 10;
  const span = entry.range ? entry.range.max - entry.range.min : 100;
  if (span <= 3) return 0.05;
  if (span >= 10000) return 500;
  if (entry.range?.min === 100 && entry.range.max === 900) return 100;
  return 1;
}

/** The unit a value is WRITTEN with: lengths and durations carry it, numbers and ratios are bare. */
function writtenUnit(entry: StyleRegistryEntry): string {
  return entry.kind === 'length' || entry.kind === 'duration' ? entry.unit ?? '' : '';
}

/** A value as a number in the entry's unit; null when it is a keyword, rem, or anything else. */
export function stepperNumber(entry: StyleRegistryEntry, value: string): number | null {
  const v = value.trim();
  if (entry.kind === 'length' && v === '0') return 0;
  const unit = writtenUnit(entry);
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z]*)$/i.exec(v);
  if (!m?.[1]) return null;
  const given = m[2] ?? '';
  if (given !== unit && !(entry.kind === 'number' && given === entry.unit)) return null;
  return Number(m[1]);
}

export function StepperWidget({
  entry,
  value,
  inherited,
  setVar,
}: {
  entry: StyleRegistryEntry;
  value: string | undefined;
  inherited: string;
  setVar?: SetVar;
}) {
  const key = entry.key;
  const shown = value ?? inherited;
  const keywords = entry.kind === 'number' ? entry.values ?? [] : [];
  const keyword = keywords.includes(shown.trim()) ? shown.trim() : null;
  const n = keyword ? null : stepperNumber(entry, shown);
  const unit = writtenUnit(entry);
  const step = stepFor(entry);
  const min = entry.range?.min;
  const max = entry.range?.max;
  const write = (next: number) => {
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next));
    const text = `${cssNumber(Math.round(clamped / step) * step)}${unit}`;
    setVar?.(key, text === inherited ? null : text);
  };
  /* The number a keyword (`auto`) steps away from: the foundation's, else the range floor. */
  const fallback = stepperNumber(entry, inherited) ?? min ?? 0;

  if (!setVar) return <code className="styleed__varval">{shown}</code>;
  if (n === null && !keyword) {
    return (
      <input
        className="styleed__input"
        value={value ?? ''}
        placeholder={inherited}
        aria-label={key}
        spellCheck={false}
        onChange={(e) => setVar(key, e.target.value === '' ? null : e.target.value)}
      />
    );
  }
  const unitLabel = entry.unit ?? (entry.kind === 'ratio' ? '×' : '');
  return (
    <span className="stylew__stepper" title={entry.kind === 'duration' ? '0 = reduced motion' : undefined}>
      <button
        type="button"
        className="stylew__step"
        aria-label={`decrease ${key}`}
        disabled={keyword !== null}
        onClick={() => write((n ?? fallback) - step)}
      >
        −
      </button>
      <input
        type="number"
        className="styleed__input stylew__num"
        value={keyword ? '' : n ?? ''}
        placeholder={keyword ?? undefined}
        disabled={keyword !== null}
        step={step}
        min={min}
        max={max}
        aria-label={key}
        onChange={(e) => {
          if (e.target.value === '') setVar(key, null);
          else write(Number(e.target.value));
        }}
      />
      <button
        type="button"
        className="stylew__step"
        aria-label={`increase ${key}`}
        disabled={keyword !== null}
        onClick={() => write((n ?? fallback) + step)}
      >
        +
      </button>
      {unitLabel ? <span className="stylew__unit">{unitLabel}</span> : null}
      {keywords.map((k) => (
        <label key={k} className="styleed__check stylew__kw">
          <input
            type="checkbox"
            checked={keyword === k}
            onChange={(e) => {
              if (e.target.checked) setVar(key, k === inherited ? null : k);
              else write(fallback);
            }}
          />
          {k}
        </label>
      ))}
    </span>
  );
}

// ── font ───────────────────────────────────────────────────────────────────

interface FontOption {
  label: string;
  stack: string;
}

/** §2 font row: the fonts tm8 ships, then stacks every platform resolves. */
export const BUNDLED_FONTS: readonly FontOption[] = [
  { label: 'Hanken Grotesk', stack: "'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { label: 'Newsreader', stack: 'Newsreader, Georgia, serif' },
  { label: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
];

export const SYSTEM_FONTS: readonly FontOption[] = [
  { label: 'System UI', stack: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { label: 'System serif', stack: 'ui-serif, Georgia, serif' },
  { label: 'System mono', stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  { label: 'Georgia', stack: "Georgia, 'Times New Roman', serif" },
  { label: 'Helvetica / Arial', stack: 'Helvetica, Arial, sans-serif' },
  { label: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
  { label: 'Menlo / Consolas', stack: 'Menlo, Consolas, monospace' },
  { label: 'Courier New', stack: "'Courier New', Courier, monospace" },
];

const CUSTOM = '__custom__';

function genericFor(entry: StyleRegistryEntry): string {
  return /mono|term/.test(entry.key) ? 'monospace' : /serif/.test(entry.key) ? 'serif' : 'sans-serif';
}

/** Installed families via the Local Font Access API, where the browser has it (Chromium, with permission). */
async function installedFamilies(): Promise<string[]> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!query) return [];
  const fonts = await query();
  return [...new Set(fonts.map((f) => f.family))]
    .filter((f) => f.length <= 128 && !/['"\\]/.test(f))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 400);
}

export function FontWidget({
  entry,
  value,
  inherited,
  setVar,
}: {
  entry: StyleRegistryEntry;
  value: string | undefined;
  inherited: string;
  setVar?: SetVar;
}) {
  const [installed, setInstalled] = useState<string[] | null>(null);
  const key = entry.key;
  const shown = value ?? inherited;
  const generic = genericFor(entry);
  const installedOptions = (installed ?? []).map((f) => ({ label: f, stack: `'${f}', ${generic}` }));
  const all = [...BUNDLED_FONTS, ...SYSTEM_FONTS, ...installedOptions];
  const selected = value === undefined ? '' : all.find((o) => o.stack === value)?.stack ?? CUSTOM;
  const canList = typeof window !== 'undefined' && 'queryLocalFonts' in window;

  if (!setVar) return <code className="styleed__varval" style={{ fontFamily: shown }}>{shown}</code>;
  return (
    <span className="stylew__font">
      <select
        className="styleed__input"
        value={selected}
        aria-label={`${key} font`}
        style={{ fontFamily: shown }}
        onChange={(e) => {
          if (e.target.value === CUSTOM) return;
          setVar(key, e.target.value === '' || e.target.value === inherited ? null : e.target.value);
        }}
      >
        <option value="">Foundation</option>
        <optgroup label="Bundled">
          {BUNDLED_FONTS.map((o) => (
            <option key={o.stack} value={o.stack}>
              {o.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="System">
          {SYSTEM_FONTS.map((o) => (
            <option key={o.stack} value={o.stack}>
              {o.label}
            </option>
          ))}
        </optgroup>
        {installedOptions.length ? (
          <optgroup label="Installed">
            {installedOptions.map((o) => (
              <option key={o.stack} value={o.stack}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : null}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {canList && installed === null ? (
        <button
          type="button"
          className="styleed__link"
          title="List the fonts installed on this device (the browser asks first)"
          onClick={() => void installedFamilies().then(setInstalled, () => setInstalled([]))}
        >
          Installed…
        </button>
      ) : null}
      <input
        className="styleed__input"
        value={value ?? ''}
        placeholder={inherited}
        aria-label={key}
        spellCheck={false}
        onChange={(e) => setVar(key, e.target.value === '' ? null : e.target.value)}
      />
    </span>
  );
}

// ── shadow, easing, enum ───────────────────────────────────────────────────

export function ShadowWidget({
  entry,
  value,
  inherited,
  painted,
  setVar,
}: {
  entry: StyleRegistryEntry;
  value: string | undefined;
  inherited: string;
  painted: string;
  setVar?: SetVar;
}) {
  const key = entry.key;
  return (
    <span className="stylew__shadow">
      <span className="stylew__shadowcard" style={{ boxShadow: painted }} aria-hidden data-testid={`shadow-${key}`} />
      {setVar ? (
        <input
          className="styleed__input"
          value={value ?? ''}
          placeholder={inherited}
          aria-label={key}
          spellCheck={false}
          onChange={(e) => setVar(key, e.target.value === '' ? null : e.target.value)}
        />
      ) : (
        <code className="styleed__varval">{value ?? inherited}</code>
      )}
    </span>
  );
}

export const EASINGS: readonly { label: string; value: string }[] = [
  { label: 'Out (expo)', value: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  { label: 'Standard', value: 'cubic-bezier(0.2, 0, 0, 1)' },
  { label: 'In-out (sine)', value: 'cubic-bezier(0.37, 0, 0.63, 1)' },
  { label: 'Back out', value: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
  { label: 'ease', value: 'ease' },
  { label: 'ease-in', value: 'ease-in' },
  { label: 'ease-out', value: 'ease-out' },
  { label: 'ease-in-out', value: 'ease-in-out' },
  { label: 'linear', value: 'linear' },
];

const KEYWORD_CURVES: Record<string, [number, number, number, number]> = {
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
  linear: [0, 0, 1, 1],
};

/** The four control numbers of a cubic easing; null for steps() or anything else. */
export function bezierOf(value: string): [number, number, number, number] | null {
  const v = value.trim();
  if (KEYWORD_CURVES[v]) return KEYWORD_CURVES[v];
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(v);
  const nums = m?.[1]?.split(',').map((x) => Number(x.trim()));
  return nums && nums.length === 4 && nums.every(Number.isFinite) ? (nums as [number, number, number, number]) : null;
}

function normEasing(v: string): string {
  return v.replace(/\s+/g, '').toLowerCase();
}

export function EasingWidget({
  entry,
  value,
  inherited,
  setVar,
}: {
  entry: StyleRegistryEntry;
  value: string | undefined;
  inherited: string;
  setVar?: SetVar;
}) {
  const key = entry.key;
  const shown = value ?? inherited;
  const curve = bezierOf(shown);
  const preset = value === undefined ? '' : EASINGS.find((e) => normEasing(e.value) === normEasing(value))?.value ?? CUSTOM;
  /* y spans -0.6..1.6 so overshooting curves stay inside the 40×40 box. */
  const y = (n: number) => 40 - ((n + 0.6) / 2.2) * 40;
  return (
    <span className="stylew__easing">
      <svg className="stylew__curve" viewBox="0 0 40 40" aria-hidden>
        <line x1="0" y1={y(0)} x2="40" y2={y(1)} className="stylew__curvebase" />
        {curve ? (
          <path
            d={`M0 ${y(0)} C${curve[0] * 40} ${y(curve[1])} ${curve[2] * 40} ${y(curve[3])} 40 ${y(1)}`}
            className="stylew__curveline"
          />
        ) : null}
      </svg>
      {setVar ? (
        <>
          <select
            className="styleed__input"
            value={preset}
            aria-label={`${key} preset`}
            onChange={(e) => {
              if (e.target.value === CUSTOM) return;
              setVar(key, e.target.value === '' || e.target.value === inherited ? null : e.target.value);
            }}
          >
            <option value="">Foundation</option>
            {EASINGS.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
          <input
            className="styleed__input"
            value={value ?? ''}
            placeholder={inherited}
            aria-label={key}
            spellCheck={false}
            onChange={(e) => setVar(key, e.target.value === '' ? null : e.target.value)}
          />
        </>
      ) : (
        <code className="styleed__varval">{shown}</code>
      )}
    </span>
  );
}

function EnumWidget({
  entry,
  value,
  inherited,
  setVar,
}: {
  entry: StyleRegistryEntry;
  value: string | undefined;
  inherited: string;
  setVar?: SetVar;
}) {
  const key = entry.key;
  const shown = value ?? inherited;
  if (!setVar) return <code className="styleed__varval">{shown}</code>;
  return (
    <select
      className="styleed__input"
      value={shown}
      aria-label={key}
      onChange={(e) => setVar(key, e.target.value === inherited ? null : e.target.value)}
    >
      {(entry.values ?? []).map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
}

/** The widget for one registry entry, by kind. `derived` keys have none (§2: hidden). */
export function VarWidget({
  entry,
  value,
  inherited,
  painted,
  setVar,
}: {
  entry: StyleRegistryEntry;
  value: string | undefined;
  inherited: string;
  painted: string;
  setVar?: SetVar;
}) {
  const props = { entry, value, inherited, ...(setVar ? { setVar } : {}) };
  switch (entry.kind) {
    case 'colour':
      return <ColourWidget {...props} painted={painted} />;
    case 'length':
    case 'ratio':
    case 'number':
    case 'duration':
      return <StepperWidget {...props} />;
    case 'font':
      return <FontWidget {...props} />;
    case 'shadow':
      return <ShadowWidget {...props} painted={painted} />;
    case 'easing':
      return <EasingWidget {...props} />;
    case 'enum':
      return <EnumWidget {...props} />;
    case 'derived':
      return null;
  }
}

// ── ANSI grid ──────────────────────────────────────────────────────────────

const ANSI_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright black', 'bright red', 'bright green', 'bright yellow', 'bright blue', 'bright magenta', 'bright cyan', 'bright white',
];

export const ANSI_KEY = /^--pn-x-term-ansi-(\d+)$/;

/** The 16 ANSI slots as a 2×8 grid of swatches, each opening the colour picker (§2 "ANSI shown as a 16-cell grid"). */
export function AnsiGrid({
  entries,
  vars,
  foundationTokens,
  painted,
  setVar,
}: {
  entries: readonly StyleRegistryEntry[];
  vars: Record<string, string>;
  foundationTokens: Record<string, string>;
  painted: StyleTokenTable;
  setVar?: SetVar;
}) {
  const slots = entries
    .map((e) => ({ e, i: Number(ANSI_KEY.exec(e.key)?.[1] ?? -1) }))
    .filter((s) => s.i >= 0)
    .sort((a, b) => a.i - b.i);
  return (
    <div className="stylew__ansi" role="group" aria-label="ANSI colours" data-testid="ansi-grid">
      {slots.map(({ e, i }) => (
        <span key={e.key} className={`stylew__ansicell${vars[e.key] !== undefined ? ' stylew__ansicell--set' : ''}`}>
          <ColourWidget
            entry={e}
            value={vars[e.key]}
            inherited={foundationTokens[e.key] ?? ''}
            painted={painted[e.key] ?? foundationTokens[e.key] ?? ''}
            label={`${i} ${ANSI_NAMES[i] ?? ''}`}
            compact
            {...(setVar ? { setVar } : {})}
          />
          <span className="stylew__ansinum">{i}</span>
        </span>
      ))}
    </div>
  );
}

// ── xterm sample ───────────────────────────────────────────────────────────

type Slot = keyof ReturnType<typeof buildTerminalTheme>;
type Seg = [string, Slot?, 'bold'?];

const SAMPLE: Seg[][] = [
  [['~/tm8 ', 'blue', 'bold'], ['(main) ', 'magenta'], ['$ ', 'foreground'], ['ls --color', 'foreground']],
  [['packages ', 'blue', 'bold'], ['scripts ', 'blue', 'bold'], ['build.sh ', 'green', 'bold'], ['README.md ', 'foreground'], ['link ', 'cyan']],
  [['$ ', 'foreground'], ['git diff --stat', 'foreground']],
  [[' style.ts | 12 ', 'foreground'], ['++++++++', 'green'], ['----', 'red']],
  [['warning: ', 'yellow', 'bold'], ['contrast below 4.5:1', 'foreground']],
  [['error: ', 'brightRed', 'bold'], ['build failed', 'red']],
  [['dim ', 'brightBlack'], ['white ', 'white'], ['bright ', 'brightWhite'], ['cyan ', 'brightCyan'], ['blue ', 'brightBlue'], ['green ', 'brightGreen'], ['yellow ', 'brightYellow'], ['magenta', 'brightMagenta']],
];

/**
 * A static terminal painted with LiveTerminal's own mapping
 * (`terminalStyleOptions` / `buildTerminalTheme` over `resolved.xterm`), so
 * what it shows is what an open terminal will use: the always-dark ramp when
 * `--pn-term-chrome` is dark, font, weights, line height, letter spacing,
 * padding and cursor style. A DOM sample, not a pty: nothing runs.
 */
export function XtermSample({ resolved }: { resolved: ResolvedStyle }) {
  const o = terminalStyleOptions(resolved.xterm);
  const t = o.theme as Record<string, string | undefined>;
  const cursorStyle =
    o.cursorStyle === 'block'
      ? { background: t.cursor, color: t.cursorAccent }
      : o.cursorStyle === 'underline'
        ? { boxShadow: `inset 0 -2px 0 ${t.cursor}` }
        : { boxShadow: `inset 2px 0 0 ${t.cursor}` };
  return (
    <pre
      className="stylew__xterm"
      data-testid="xterm-sample"
      data-cursor={o.cursorStyle}
      style={{
        background: t.background,
        color: t.foreground,
        fontFamily: o.fontFamily,
        fontSize: `${o.fontSize}px`,
        fontWeight: o.fontWeight,
        lineHeight: o.lineHeight,
        letterSpacing: `${o.letterSpacing}px`,
        padding: `${resolved.xterm.options.padding}px`,
      }}
    >
      {SAMPLE.map((line, i) => (
        <div key={i}>
          {line.map(([text, slot, bold], j) => (
            <span key={j} style={{ color: slot ? t[slot] : undefined, fontWeight: bold ? o.fontWeightBold : undefined }}>
              {text}
            </span>
          ))}
        </div>
      ))}
      <div>
        <span>$ </span>
        <span style={{ background: t.selectionBackground, color: t.selectionForeground }}>selected text</span>
        <span> </span>
        <span className="stylew__cursor" style={cursorStyle}>
          {' '}
        </span>
      </div>
    </pre>
  );
}

// ── contrast strip ─────────────────────────────────────────────────────────

const shortKey = (k: string) => k.replace(/^--pn-(x-)?/, '');

/**
 * Every pair the resolver lints (`styleContrastChecks`), as chips: the pair
 * painted, its ratio and the floor. Informational — §9.2: warnings never
 * block Save or Push.
 */
export function ContrastStrip({ table }: { table: StyleTokenTable }) {
  const checks = styleContrastChecks(table);
  const failing = checks.filter((c) => c.ratio !== null && c.ratio < c.min).length;
  return (
    <div className="stylew__contrast" data-testid="contrast-strip">
      <p className="styleed__note">
        {failing ? `${failing} pair${failing === 1 ? '' : 's'} below the floor` : 'Every checked pair meets its floor'} —
        Save and Push still work.
      </p>
      <ul className="stylew__chips">
        {checks.map((c) => {
          const fail = c.ratio !== null && c.ratio < c.min;
          return (
            <li
              key={`${c.fg}|${c.bg}`}
              className={`stylew__chip${fail ? ' stylew__chip--fail' : ''}`}
              title={`${c.fg} on ${c.bg}: needs ${c.min}:1`}
              data-fail={fail || undefined}
            >
              <span className="stylew__chipsample" style={{ color: table[c.fg], background: table[c.bg] }}>
                Aa
              </span>
              <span className="stylew__chiptext">
                {shortKey(c.fg)} / {shortKey(c.bg)}
                <strong>{c.ratio === null ? 'n/a' : `${c.ratio.toFixed(1)}:1`}</strong>
                <span className="stylew__chipmin">{fail ? '⚠' : '✓'} ≥ {c.min}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
