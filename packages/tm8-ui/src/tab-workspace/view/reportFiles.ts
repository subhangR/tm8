/**
 * THE TEST REPORT AS A FILE: a PDF and a Word (.docx) document, built in the
 * browser with no library.
 *
 * Both carry the same content: the overall status, an infographic (pass-rate
 * ring or bar, the counts, time per case), a results table, then every case
 * with its outcome, why it failed in plain words, the raw error, the evidence
 * file and its last screen.
 *
 * - PDF: one A4 document. Text is the standard Helvetica/Courier fonts
 *   (WinAnsi), charts are vector paths, and screenshots are the runner's JPEGs
 *   embedded as they are (DCTDecode), so nothing is re-encoded.
 * - DOCX: a minimal Office Open XML package (a stored zip). The infographic is
 *   native Word tables with shaded cells, so it stays editable.
 *
 * Every value is untrusted runner output: it reaches the files only as escaped
 * text, never as markup or PDF operators.
 */
import { explainFailure, formatMs, type PhoneCase, type PhoneRunState } from './phoneRun';

export type ReportFormat = 'pdf' | 'docx';
export type ReportMeta = { app: string | null; asked: string | null };

type Rgb = readonly [number, number, number];
const GREEN: Rgb = [0.094, 0.475, 0.306];
const RED: Rgb = [0.776, 0.157, 0.157];
const GREY: Rgb = [0.6, 0.6, 0.64];
const AMBER: Rgb = [0.85, 0.55, 0.05];
const INK: Rgb = [0.11, 0.11, 0.13];
const MUTED: Rgb = [0.42, 0.42, 0.46];
const PANEL: Rgb = [0.955, 0.957, 0.965];
const NAVY: Rgb = [0.09, 0.11, 0.2];
const WHITE: Rgb = [1, 1, 1];

const hex = (c: Rgb) => c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
const stateColor = (s: PhoneCase['state']): Rgb => (s === 'ok' ? GREEN : s === 'fail' ? RED : s === 'run' ? AMBER : GREY);
const stateWord = (s: PhoneCase['state']) => (s === 'ok' ? 'PASSED' : s === 'fail' ? 'FAILED' : s === 'run' ? 'DID NOT FINISH' : 'NOT RUN');
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const NOT_RUN_WHY = 'This case did not run: the run stopped before it got here.';

export type ReportSummary = {
  total: number;
  passed: number;
  failed: number;
  notRun: number;
  rate: number;
  ms: number;
  status: 'PASSED' | 'FAILED' | 'INCOMPLETE';
};

export function summarize(run: PhoneRunState): ReportSummary {
  const total = run.cases.length;
  const passed = run.cases.filter((c) => c.state === 'ok').length;
  const failed = run.cases.filter((c) => c.state === 'fail').length;
  const ms = run.done?.ms ?? run.cases.reduce((t, c) => t + (c.ms ?? 0), 0);
  const status = !run.done ? 'INCOMPLETE' : run.done.passed && failed === 0 ? 'PASSED' : 'FAILED';
  return { total, passed, failed, notRun: total - passed - failed, rate: total ? Math.round((passed / total) * 100) : 0, ms, status };
}
const statusColor = (s: ReportSummary['status']): Rgb => (s === 'PASSED' ? GREEN : s === 'FAILED' ? RED : AMBER);

/* ------------------------------------------------------------------ JPEG */

type Jpeg = { bytes: Uint8Array; w: number; h: number; comps: number };

/** A case's screenshot (a JPEG data URL) with the size read from its frame header, or null. */
export function jpegOf(dataUrl: string | undefined): Jpeg | null {
  const head = 'data:image/jpeg;base64,';
  if (!dataUrl?.startsWith(head)) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(dataUrl.slice(head.length)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < bytes.length) {
    if (bytes[p] !== 0xff) return null;
    const m = bytes[p + 1]!;
    if (m === 0xff) {
      p++;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      p += 2;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = (bytes[p + 5]! << 8) | bytes[p + 6]!;
      const w = (bytes[p + 7]! << 8) | bytes[p + 8]!;
      const comps = bytes[p + 9]!;
      return w && h && [1, 3, 4].includes(comps) ? { bytes, w, h, comps } : null;
    }
    p += 2 + ((bytes[p + 2]! << 8) | bytes[p + 3]!);
  }
  return null;
}

/* ------------------------------------------------------------------- PDF */

/* Helvetica and Helvetica-Bold advance widths for ' '..'~' (Adobe AFM, 1/1000 em). */
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278,
  278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
  556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333,
  333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722,
  667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611,
  611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
export const FONT_WIDTH_TABLES = [HELV, HELV_BOLD];

/* Characters outside Latin-1 that WinAnsiEncoding still has, at their WinAnsi code. */
const WIN_ANSI: Record<string, number> = { '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, '€': 0x80 };
const ASCII_FOR: Record<string, string> = { '✔': 'v', '✓': 'v', '✘': 'x', '✗': 'x', '→': '->', '←': '<-', '≥': '>=', '≤': '<=', '○': 'o' };

/** Text as one byte per character in WinAnsi; anything else becomes '?'. */
function winAnsi(s: string): string {
  let out = '';
  for (const ch of stripAnsi(s)) {
    const c = ch.codePointAt(0)!;
    if (ch === '\t') out += '  ';
    else if (ch === '\n') out += ch;
    else if ((c >= 32 && c < 127) || (c >= 160 && c <= 255)) out += ch;
    else if (WIN_ANSI[ch] !== undefined) out += String.fromCharCode(WIN_ANSI[ch]!);
    else if (ASCII_FOR[ch] !== undefined) out += ASCII_FOR[ch];
    else if (c >= 32) out += '?';
  }
  return out;
}

type Font = 'reg' | 'bold' | 'mono';
const FONT_NAME: Record<Font, string> = { reg: 'F1', bold: 'F2', mono: 'F3' };

function widthOf(s: string, size: number, font: Font): number {
  if (font === 'mono') return s.length * 0.6 * size;
  const table = font === 'bold' ? HELV_BOLD : HELV;
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w += c >= 32 && c <= 126 ? table[c - 32]! : c === 0x85 || c === 0x97 ? 1000 : 556;
  }
  return (w * size) / 1000;
}

/** Wraps already-WinAnsi text to a width; a word longer than a line is split. */
function wrap(s: string, size: number, font: Font, width: number): string[] {
  const lines: string[] = [];
  for (const para of s.split('\n')) {
    let line = '';
    for (let word of para.split(/ +/)) {
      while (widthOf(word, size, font) > width) {
        let n = word.length - 1;
        while (n > 1 && widthOf(word.slice(0, n), size, font) > width) n--;
        if (line) lines.push(line);
        lines.push(word.slice(0, n));
        line = '';
        word = word.slice(n);
      }
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size, font) <= width) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function clip(s: string, size: number, font: Font, width: number): string {
  if (widthOf(s, size, font) <= width) return s;
  let n = s.length;
  while (n > 1 && widthOf(`${s.slice(0, n)}\x85`, size, font) > width) n--;
  return `${s.slice(0, n)}\x85`;
}

const num = (v: number) => (Math.round(v * 100) / 100).toString();
const pdfString = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/\r/g, '')})`;
const latin1 = (s: string) => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - 2 * MARGIN;

class PdfDoc {
  private pages: string[][] = [];
  private images: Jpeg[] = [];
  /** The page being drawn on; -1 is the last one. */
  private at = -1;
  /** The top of the space left on the current page, in PDF points from the bottom. */
  y = 0;

  constructor() {
    this.newPage();
  }
  private get ops() {
    return this.pages[this.at < 0 ? this.pages.length - 1 : this.at]!;
  }
  newPage() {
    this.pages.push([]);
    this.y = PAGE_H - MARGIN;
  }
  /** Starts a new page unless `h` points still fit above the footer. */
  room(h: number) {
    if (this.y - h < MARGIN + 18) this.newPage();
  }
  rect(x: number, y: number, w: number, h: number, c: Rgb, r = 0) {
    this.ops.push(`${c.map(num).join(' ')} rg`);
    if (r <= 0) {
      this.ops.push(`${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
      return;
    }
    r = Math.min(r, w / 2, h / 2);
    const k = r * 0.5523;
    this.ops.push(
      [
        `${num(x + r)} ${num(y)} m`,
        `${num(x + w - r)} ${num(y)} l`,
        `${num(x + w - r + k)} ${num(y)} ${num(x + w)} ${num(y + r - k)} ${num(x + w)} ${num(y + r)} c`,
        `${num(x + w)} ${num(y + h - r)} l`,
        `${num(x + w)} ${num(y + h - r + k)} ${num(x + w - r + k)} ${num(y + h)} ${num(x + w - r)} ${num(y + h)} c`,
        `${num(x + r)} ${num(y + h)} l`,
        `${num(x + r - k)} ${num(y + h)} ${num(x)} ${num(y + h - r + k)} ${num(x)} ${num(y + h - r)} c`,
        `${num(x)} ${num(y + r)} l`,
        `${num(x)} ${num(y + r - k)} ${num(x + r - k)} ${num(y)} ${num(x + r)} ${num(y)} c f`,
      ].join(' '),
    );
  }
  line(x1: number, y1: number, x2: number, y2: number, c: Rgb, w = 0.6) {
    this.ops.push(`${c.map(num).join(' ')} RG ${num(w)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
  }
  /** A ring segment from angle a0 to a1 (radians, clockwise from 12 o'clock) as a thick stroked arc. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, c: Rgb, width: number) {
    if (a1 - a0 <= 0.0001) return;
    const pt = (a: number) => [cx + r * Math.sin(a), cy + r * Math.cos(a)] as const;
    const parts = Math.ceil((a1 - a0) / (Math.PI / 2));
    const step = (a1 - a0) / parts;
    const [sx, sy] = pt(a0);
    const path = [`${num(sx)} ${num(sy)} m`];
    for (let i = 0; i < parts; i++) {
      const s = a0 + i * step;
      const e = s + step;
      const k = (4 / 3) * Math.tan(step / 4) * r;
      const [x0, y0] = pt(s);
      const [x3, y3] = pt(e);
      path.push(
        `${num(x0 + k * Math.cos(s))} ${num(y0 - k * Math.sin(s))} ${num(x3 - k * Math.cos(e))} ${num(y3 + k * Math.sin(e))} ${num(x3)} ${num(y3)} c`,
      );
    }
    this.ops.push(`${c.map(num).join(' ')} RG ${num(width)} w 0 J ${path.join(' ')} S`);
  }
  /** Draws already-WinAnsi text with its baseline at y. */
  text(x: number, y: number, s: string, size: number, opts: { font?: Font; color?: Rgb; align?: 'left' | 'right' | 'center' } = {}) {
    const font = opts.font ?? 'reg';
    const w = widthOf(s, size, font);
    const left = opts.align === 'right' ? x - w : opts.align === 'center' ? x - w / 2 : x;
    this.ops.push(`BT ${(opts.color ?? INK).map(num).join(' ')} rg /${FONT_NAME[font]} ${num(size)} Tf ${num(left)} ${num(y)} Td ${pdfString(s)} Tj ET`);
  }
  image(j: Jpeg, x: number, y: number, w: number, h: number) {
    const i = this.images.push(j) - 1;
    this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /Im${i} Do Q`);
  }
  footer(title: string) {
    const n = this.pages.length;
    for (let k = 0; k < n; k++) {
      this.at = k;
      this.line(MARGIN, 30, PAGE_W - MARGIN, 30, [0.85, 0.85, 0.88]);
      this.text(MARGIN, 18, clip(title, 8, 'reg', CONTENT_W - 80), 8, { color: MUTED });
      this.text(PAGE_W - MARGIN, 18, `Page ${k + 1} of ${n}`, 8, { color: MUTED, align: 'right' });
    }
    this.at = -1;
  }
  bytes(): Uint8Array {
    const chunks: Uint8Array[] = [];
    let length = 0;
    const offsets: number[] = [];
    const put = (part: Uint8Array | string) => {
      const b = typeof part === 'string' ? latin1(part) : part;
      chunks.push(b);
      length += b.length;
    };
    const obj = (id: number, ...parts: (Uint8Array | string)[]) => {
      offsets[id] = length;
      put(`${id} 0 obj\n`);
      parts.forEach(put);
      put('\nendobj\n');
    };
    const imageBase = 7;
    const pageBase = imageBase + this.images.length;
    const pageId = (k: number) => pageBase + 2 * k + 1;
    put('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${this.pages.map((_, k) => `${pageId(k)} 0 R`).join(' ')}] /Count ${this.pages.length} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
    obj(6, `<< /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> /XObject << ${this.images.map((_, i) => `/Im${i} ${imageBase + i} 0 R`).join(' ')} >> >>`);
    this.images.forEach((j, i) => {
      const space = j.comps === 1 ? '/DeviceGray' : j.comps === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
      obj(
        imageBase + i,
        `<< /Type /XObject /Subtype /Image /Width ${j.w} /Height ${j.h} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode /Length ${j.bytes.length} >>\nstream\n`,
        j.bytes,
        '\nendstream',
      );
    });
    this.pages.forEach((ops, k) => {
      const content = latin1(ops.join('\n'));
      obj(pageBase + 2 * k, `<< /Length ${content.length} >>\nstream\n`, content, '\nendstream');
      obj(pageId(k), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources 6 0 R /Contents ${pageBase + 2 * k} 0 R >>`);
    });
    const xref = length;
    const size = pageBase + 2 * this.pages.length;
    put(`xref\n0 ${size}\n0000000000 65535 f \n`);
    for (let i = 1; i < size; i++) put(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
    put(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

const when = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export function reportPdf(run: PhoneRunState, meta: ReportMeta): Uint8Array {
  const sum = summarize(run);
  const doc = new PdfDoc();
  const title = winAnsi(run.title ?? 'Test run');
  const sub = winAnsi([meta.app, run.device, when(run.startedAt), run.runName ? `run ${run.runName}` : null].filter(Boolean).join('  •  '));

  /* Header band. */
  doc.rect(0, PAGE_H - 96, PAGE_W, 96, NAVY);
  doc.text(MARGIN, PAGE_H - 34, 'TEST REPORT', 9, { font: 'bold', color: [0.6, 0.68, 0.95] });
  doc.text(MARGIN, PAGE_H - 58, clip(title, 20, 'bold', CONTENT_W), 20, { font: 'bold', color: WHITE });
  doc.text(MARGIN, PAGE_H - 78, clip(sub, 9, 'reg', CONTENT_W), 9, { color: [0.78, 0.8, 0.88] });
  doc.y = PAGE_H - 116;

  /* Overall status banner. */
  const sc = statusColor(sum.status);
  doc.rect(MARGIN, doc.y - 58, CONTENT_W, 58, sc, 10);
  doc.text(MARGIN + 18, doc.y - 24, 'OVERALL STATUS', 9, { font: 'bold', color: [1, 1, 1] });
  doc.text(MARGIN + 18, doc.y - 46, sum.status, 22, { font: 'bold', color: WHITE });
  doc.text(PAGE_W - MARGIN - 18, doc.y - 26, `${sum.passed} of ${sum.total} cases passed`, 13, { font: 'bold', color: WHITE, align: 'right' });
  doc.text(PAGE_W - MARGIN - 18, doc.y - 44, winAnsi(`Pass rate ${sum.rate}%  •  total time ${formatMs(sum.ms) || '-'}`), 10, {
    color: WHITE,
    align: 'right',
  });
  doc.y -= 80;

  /* Infographic: the pass-rate ring with its legend, and six figures. */
  const cx = MARGIN + 78;
  const cy = doc.y - 74;
  const r = 52;
  const full = 2 * Math.PI;
  if (!sum.total) doc.arc(cx, cy, r, 0, full - 0.0001, GREY, 20);
  else {
    let a = 0;
    for (const [n, c] of [
      [sum.passed, GREEN],
      [sum.failed, RED],
      [sum.notRun, GREY],
    ] as const) {
      const span = (n / sum.total) * full;
      doc.arc(cx, cy, r, a, a + span - (n === sum.total ? 0.0001 : 0), c, 20);
      a += span;
    }
  }
  doc.text(cx, cy - 2, `${sum.rate}%`, 20, { font: 'bold', align: 'center' });
  doc.text(cx, cy - 15, 'pass rate', 8, { color: MUTED, align: 'center' });
  let lx = MARGIN + 4;
  for (const [label, c] of [
    ['Passed', GREEN],
    ['Failed', RED],
    ['Not run', GREY],
  ] as const) {
    doc.rect(lx, cy - r - 30, 8, 8, c, 2);
    doc.text(lx + 12, cy - r - 29, label, 8, { color: MUTED });
    lx += 52;
  }
  const tiles: [string, string, Rgb][] = [
    ['Test cases', String(sum.total), INK],
    ['Passed', String(sum.passed), GREEN],
    ['Failed', String(sum.failed), RED],
    ['Not run', String(sum.notRun), GREY],
    ['Total time', formatMs(sum.ms) || '-', INK],
    ['Avg per case', sum.total ? formatMs(Math.round(sum.ms / sum.total)) : '-', INK],
  ];
  const gx = MARGIN + 180;
  const tw = (PAGE_W - MARGIN - gx - 2 * 10) / 3;
  tiles.forEach(([label, value, c], i) => {
    const x = gx + (i % 3) * (tw + 10);
    const y = doc.y - 66 - Math.floor(i / 3) * 76;
    doc.rect(x, y, tw, 66, PANEL, 8);
    doc.rect(x, y, 4, 66, c);
    doc.text(x + 14, y + 30, winAnsi(value), 20, { font: 'bold', color: c });
    doc.text(x + 14, y + 14, label, 9, { color: MUTED });
  });
  doc.y -= 176;

  const heading = (s: string) => {
    doc.room(40);
    doc.y -= 18;
    doc.text(MARGIN, doc.y, s, 13, { font: 'bold' });
    doc.y -= 6;
    doc.line(MARGIN, doc.y, PAGE_W - MARGIN, doc.y, [0.85, 0.85, 0.88]);
    doc.y -= 14;
  };

  if (meta.asked) {
    heading('What was asked');
    for (const l of wrap(winAnsi(meta.asked), 10, 'reg', CONTENT_W).slice(0, 10)) {
      doc.room(14);
      doc.text(MARGIN, doc.y, l, 10);
      doc.y -= 14;
    }
  }

  /* Time per case, as bars coloured by outcome. */
  if (run.cases.length) {
    heading('Time per case');
    const max = Math.max(1, ...run.cases.map((c) => c.ms ?? 0));
    const bx = MARGIN + 200;
    const bw = CONTENT_W - 200 - 56;
    run.cases.forEach((c, i) => {
      doc.room(18);
      doc.text(MARGIN, doc.y - 9, clip(winAnsi(`${i + 1}. ${c.name}`), 9, 'reg', 192), 9);
      const w = c.ms !== undefined ? Math.max(3, (c.ms / max) * bw) : 0;
      doc.rect(bx, doc.y - 12, bw, 12, PANEL, 3);
      if (w) doc.rect(bx, doc.y - 12, w, 12, stateColor(c.state), 3);
      doc.text(bx + (w || 0) + 6, doc.y - 9, c.ms !== undefined ? formatMs(c.ms) : stateWord(c.state).toLowerCase(), 8, { color: MUTED });
      doc.y -= 18;
    });

    /* Results at a glance. */
    heading('Results at a glance');
    const cols = [24, CONTENT_W - 24 - 110 - 92 - 60, 110, 92, 60];
    const xs = cols.map((_, i) => MARGIN + cols.slice(0, i).reduce((a, b) => a + b, 0));
    const row = (cells: string[], y: number, bold: boolean, color: Rgb, resultColor?: Rgb) =>
      cells.forEach((cell, i) => {
        const s = clip(cell, 9, bold ? 'bold' : 'reg', cols[i]! - 10);
        if (i === 3 && resultColor) {
          doc.rect(xs[i]! + 2, y - 4, widthOf(s, 8, 'bold') + 12, 14, resultColor, 7);
          doc.text(xs[i]! + 8, y, s, 8, { font: 'bold', color: WHITE });
        } else doc.text(xs[i]! + 5, y, s, 9, { font: bold ? 'bold' : 'reg', color });
      });
    doc.room(22);
    doc.rect(MARGIN, doc.y - 20, CONTENT_W, 20, NAVY, 4);
    row(['#', 'Case', 'Group', 'Result', 'Time'], doc.y - 14, true, WHITE);
    doc.y -= 20;
    run.cases.forEach((c, i) => {
      doc.room(20);
      if (i % 2) doc.rect(MARGIN, doc.y - 20, CONTENT_W, 20, PANEL);
      row([String(i + 1), winAnsi(c.name), winAnsi(c.group || '-'), stateWord(c.state), formatMs(c.ms) || '-'], doc.y - 14, false, INK, stateColor(c.state));
      doc.y -= 20;
    });
  }

  /* Every case, with its evidence. */
  if (run.cases.length) {
    doc.newPage();
    doc.text(MARGIN, doc.y - 14, 'Case details & evidence', 16, { font: 'bold' });
    doc.y -= 32;
  }
  run.cases.forEach((c, i) => {
    const shot = jpegOf(c.shot);
    let iw = 0;
    let ih = 0;
    if (shot) {
      iw = shot.w >= shot.h ? 230 : 150;
      ih = (iw * shot.h) / shot.w;
      if (ih > 320) {
        iw = (iw * 320) / ih;
        ih = 320;
      }
    }
    const textW = CONTENT_W - 32 - (shot ? iw + 16 : 0);
    const name = wrap(winAnsi(`${i + 1}. ${c.name}`), 12, 'bold', textW).slice(0, 3);
    const facts = winAnsi([c.group, formatMs(c.ms)].filter(Boolean).join('  •  '));
    const why = c.state === 'fail' || c.state === 'run' ? wrap(winAnsi(`Why: ${explainFailure(c.error)}`), 10, 'reg', textW).slice(0, 8) : [];
    const ok = wrap(c.state === 'ok' ? 'The case ran to the end and every check in it held.' : c.state === 'planned' ? NOT_RUN_WHY : '', 10, 'reg', textW).filter(Boolean);
    const err = c.error ? wrap(winAnsi(c.error), 7.5, 'mono', textW - 12).slice(0, 14) : [];
    const file = c.file ? wrap(winAnsi(`Evidence: runs/${run.runName ?? ''}/${c.file}`), 8, 'reg', textW) : [];
    const textH = name.length * 16 + 26 + (facts ? 14 : 0) + (why.length + ok.length) * 13 + (err.length ? err.length * 9.5 + 14 : 0) + file.length * 11;
    const h = Math.max(textH, ih) + 28;
    doc.room(h + 12);
    const top = doc.y;
    const col = stateColor(c.state);
    doc.rect(MARGIN, top - h, CONTENT_W, h, PANEL, 10);
    doc.rect(MARGIN, top - h, 5, h, col);
    let y = top - 22;
    const x = MARGIN + 18;
    for (const l of name) {
      doc.text(x, y, l, 12, { font: 'bold' });
      y -= 16;
    }
    const word = stateWord(c.state);
    doc.rect(x, y - 6, widthOf(word, 8, 'bold') + 14, 15, col, 7);
    doc.text(x + 7, y - 1, word, 8, { font: 'bold', color: WHITE });
    y -= 26;
    if (facts) {
      doc.text(x, y, facts, 9, { color: MUTED });
      y -= 14;
    }
    for (const l of [...why, ...ok]) {
      doc.text(x, y, l, 10);
      y -= 13;
    }
    if (err.length) {
      y -= 4;
      const boxH = err.length * 9.5 + 8;
      doc.rect(x, y - boxH + 8, textW, boxH, WHITE, 4);
      for (const l of err) {
        doc.text(x + 6, y, l, 7.5, { font: 'mono', color: [0.35, 0.1, 0.1] });
        y -= 9.5;
      }
      y -= 12;
    }
    for (const l of file) {
      doc.text(x, y, l, 8, { color: MUTED });
      y -= 11;
    }
    if (shot) doc.image(shot, PAGE_W - MARGIN - 14 - iw, top - 14 - ih, iw, ih);
    doc.y = top - h - 12;
  });

  doc.footer(winAnsi(`tm8  •  Test report  •  ${run.title ?? 'Test run'}`));
  return doc.bytes();
}

/* ------------------------------------------------------------------ DOCX */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip of stored (uncompressed) entries: all a .docx needs, and JPEGs do not compress anyway. */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const utf8 = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    [
      [0, 0x04034b50, 4],
      [4, 20, 2],
      [6, 0x0800, 2],
      [8, 0, 2],
      [10, time, 2],
      [12, date, 2],
      [14, crc, 4],
      [18, f.data.length, 4],
      [22, f.data.length, 4],
      [26, name.length, 2],
      [28, 0, 2],
    ].forEach(([at, v, n]) => (n === 4 ? local.setUint32(at!, v!, true) : local.setUint16(at!, v!, true)));
    const cd = new DataView(new ArrayBuffer(46));
    [
      [0, 0x02014b50, 4],
      [4, 20, 2],
      [6, 20, 2],
      [8, 0x0800, 2],
      [10, 0, 2],
      [12, time, 2],
      [14, date, 2],
      [16, crc, 4],
      [20, f.data.length, 4],
      [24, f.data.length, 4],
      [28, name.length, 2],
      [42, offset, 4],
    ].forEach(([at, v, n]) => (n === 4 ? cd.setUint32(at!, v!, true) : cd.setUint16(at!, v!, true)));
    parts.push(new Uint8Array(local.buffer), name, f.data);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cdSize = central.reduce((t, b) => t + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((t, b) => t + b.length, 0));
  let at = 0;
  for (const b of all) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

const xml = (s: string) =>
  stripAnsi(s)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

type Run = { text: string; bold?: boolean; color?: Rgb; size?: number; mono?: boolean; fill?: Rgb };
const wRun = (r: Run) =>
  r.text
    .split('\n')
    .map(
      (line, i) =>
        `<w:r><w:rPr>${r.mono ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>' : ''}${r.bold ? '<w:b/>' : ''}${
          r.color ? `<w:color w:val="${hex(r.color)}"/>` : ''
        }${r.size ? `<w:sz w:val="${r.size * 2}"/><w:szCs w:val="${r.size * 2}"/>` : ''}${r.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(r.fill)}"/>` : ''}</w:rPr>${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>`,
    )
    .join('');
const wP = (runs: Run[] | string, o: { before?: number; after?: number; align?: 'center' | 'right'; keep?: boolean } = {}) =>
  `<w:p><w:pPr>${o.keep ? '<w:keepNext/>' : ''}<w:spacing w:before="${o.before ?? 0}" w:after="${o.after ?? 80}"/>${
    o.align ? `<w:jc w:val="${o.align}"/>` : ''
  }</w:pPr>${(typeof runs === 'string' ? [{ text: runs }] : runs).map(wRun).join('')}</w:p>`;

type Cell = { width: number; fill?: Rgb; body: string; stripe?: Rgb; valign?: 'center' | 'top' };
const NO_BORDERS = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="nil"/>`).join('');
const wTable = (rows: Cell[][], o: { borders?: boolean; gap?: number } = {}) => {
  const grid = rows[0]!.map((c) => c.width);
  const total = grid.reduce((a, b) => a + b, 0);
  const borders = o.borders
    ? ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:color="DDDDE3"/>`).join('')
    : NO_BORDERS;
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${grid
    .map((w) => `<w:gridCol w:w="${w}"/>`)
    .join('')}</w:tblGrid>${rows
    .map(
      (cells) =>
        `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells
          .map(
            (c) =>
              `<w:tc><w:tcPr><w:tcW w:w="${c.width}" w:type="dxa"/>${
                c.stripe ? `<w:tcBorders><w:left w:val="single" w:sz="36" w:color="${hex(c.stripe)}"/></w:tcBorders>` : ''
              }${c.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex(c.fill)}"/>` : ''}<w:vAlign w:val="${c.valign ?? 'center'}"/></w:tcPr>${
                c.body || wP('', { after: 0 })
              }</w:tc>`,
          )
          .join('')}</w:tr>`,
    )
    .join('')}</w:tbl>${wP('', { after: o.gap ?? 120 })}`;
};

const EMU_PER_INCH = 914400;
const wImage = (rid: string, n: number, cx: number, cy: number) =>
  `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Screenshot ${n}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="screen${n}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

export function reportDocx(run: PhoneRunState, meta: ReportMeta): Uint8Array {
  const sum = summarize(run);
  const W = 9906; /* A4 width less 1000-twip margins */
  const media: { name: string; data: Uint8Array }[] = [];
  const body: string[] = [];
  const sub = [meta.app, run.device, when(run.startedAt), run.runName ? `run ${run.runName}` : null].filter(Boolean).join('  •  ');

  /* Title band. */
  body.push(
    wTable([
      [
        {
          width: W,
          fill: NAVY,
          body:
            wP([{ text: 'TEST REPORT', bold: true, size: 9, color: [0.6, 0.68, 0.95] }], { after: 40 }) +
            wP([{ text: run.title ?? 'Test run', bold: true, size: 22, color: WHITE }], { after: 40 }) +
            wP([{ text: sub, size: 9, color: [0.78, 0.8, 0.88] }], { after: 40 }),
        },
      ],
    ]),
  );

  /* Overall status. */
  const sc = statusColor(sum.status);
  body.push(
    wTable([
      [
        {
          width: W * 0.5,
          fill: sc,
          body:
            wP([{ text: 'OVERALL STATUS', bold: true, size: 9, color: WHITE }], { after: 0 }) +
            wP([{ text: sum.status, bold: true, size: 24, color: WHITE }], { after: 0 }),
        },
        {
          width: W * 0.5,
          fill: sc,
          body:
            wP([{ text: `${sum.passed} of ${sum.total} cases passed`, bold: true, size: 14, color: WHITE }], { after: 0, align: 'right' }) +
            wP([{ text: `Pass rate ${sum.rate}%  •  total time ${formatMs(sum.ms) || '-'}`, size: 10, color: WHITE }], { after: 0, align: 'right' }),
        },
      ],
    ]),
  );

  /* Infographic: six figures, then the pass-rate bar. */
  const tile = (label: string, value: string, c: Rgb): Cell => ({
    width: Math.floor(W / 6),
    fill: PANEL,
    stripe: c,
    body: wP([{ text: value, bold: true, size: 18, color: c }], { after: 0 }) + wP([{ text: label, size: 8, color: MUTED }], { after: 0 }),
  });
  body.push(wP([{ text: 'At a glance', bold: true, size: 14 }], { before: 120, keep: true }));
  body.push(
    wTable([
      [
        tile('Test cases', String(sum.total), INK),
        tile('Passed', String(sum.passed), GREEN),
        tile('Failed', String(sum.failed), RED),
        tile('Not run', String(sum.notRun), GREY),
        tile('Pass rate', `${sum.rate}%`, sc),
        tile('Total time', formatMs(sum.ms) || '-', INK),
      ],
    ]),
  );
  if (sum.total) {
    const segs = (
      [
        [sum.passed, GREEN, 'passed'],
        [sum.failed, RED, 'failed'],
        [sum.notRun, GREY, 'not run'],
      ] as const
    ).filter(([n]) => n > 0);
    const widths = segs.map(([n]) => Math.max(400, Math.round((n / sum.total) * W)));
    const over = widths.reduce((a, b) => a + b, 0) - W;
    widths[widths.indexOf(Math.max(...widths))]! -= over;
    body.push(
      wTable([
        segs.map(([n, c, label], i) => ({
          width: widths[i]!,
          fill: c,
          body: wP([{ text: `${Math.round((n / sum.total) * 100)}% ${label}`, bold: true, size: 8, color: WHITE }], { after: 0, align: 'center' }),
        })),
      ]),
    );
  }

  if (meta.asked) {
    body.push(wP([{ text: 'What was asked', bold: true, size: 14 }], { before: 120, keep: true }));
    body.push(wP(meta.asked, { after: 160 }));
  }

  if (run.cases.length) {
    /* Time per case. */
    const max = Math.max(1, ...run.cases.map((c) => c.ms ?? 0));
    const nameW = 3200;
    const barW = W - nameW - 1100;
    body.push(wP([{ text: 'Time per case', bold: true, size: 14 }], { before: 120, keep: true }));
    body.push(
      wTable(
        run.cases.map((c, i) => {
          const w = c.ms !== undefined ? Math.max(120, Math.round((c.ms / max) * (barW - 240))) : 0;
          const bar: Cell[] = w ? [{ width: w, fill: stateColor(c.state), body: '' }] : [];
          if (barW - 240 - w > 0) bar.push({ width: barW - 240 - w, fill: PANEL, body: '' });
          return [
            { width: nameW, body: wP([{ text: `${i + 1}. ${c.name}`, size: 9 }], { after: 0 }) },
            { width: barW, body: wTable([bar], { gap: 0 }).replace('<w:tblCellMar><w:top w:w="80"', '<w:tblCellMar><w:top w:w="30"').replace('<w:bottom w:w="80"', '<w:bottom w:w="30"') },
            { width: 1100, body: wP([{ text: c.ms !== undefined ? formatMs(c.ms) : stateWord(c.state).toLowerCase(), size: 8, color: MUTED }], { after: 0 }) },
          ];
        }),
      ),
    );

    /* Results at a glance. */
    const cols = [500, W - 500 - 2000 - 1700 - 1100, 2000, 1700, 1100];
    const head = (t: string, i: number): Cell => ({ width: cols[i]!, fill: NAVY, body: wP([{ text: t, bold: true, size: 9, color: WHITE }], { after: 0 }) });
    body.push(wP([{ text: 'Results', bold: true, size: 14 }], { before: 120, keep: true }));
    body.push(
      wTable(
        [
          ['#', 'Case', 'Group', 'Result', 'Time'].map(head),
          ...run.cases.map((c, i): Cell[] => [
            { width: cols[0]!, fill: i % 2 ? PANEL : undefined, body: wP(String(i + 1), { after: 0 }) },
            { width: cols[1]!, fill: i % 2 ? PANEL : undefined, body: wP(c.name, { after: 0 }) },
            { width: cols[2]!, fill: i % 2 ? PANEL : undefined, body: wP([{ text: c.group || '-', color: MUTED, size: 9 }], { after: 0 }) },
            { width: cols[3]!, fill: stateColor(c.state), body: wP([{ text: stateWord(c.state), bold: true, size: 9, color: WHITE }], { after: 0, align: 'center' }) },
            { width: cols[4]!, fill: i % 2 ? PANEL : undefined, body: wP(formatMs(c.ms) || '-', { after: 0 }) },
          ]),
        ],
        { borders: true },
      ),
    );

    /* Every case, with its evidence. */
    body.push(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>`);
    body.push(wP([{ text: 'Case details & evidence', bold: true, size: 18 }], { after: 160 }));
    run.cases.forEach((c, i) => {
      const shot = jpegOf(c.shot);
      const col = stateColor(c.state);
      let text =
        wP([{ text: `${i + 1}. ${c.name}`, bold: true, size: 13 }], { after: 60 }) +
        wP(
          [
            { text: `  ${stateWord(c.state)}  `, bold: true, size: 9, color: WHITE, fill: col },
            { text: [c.group, formatMs(c.ms)].filter(Boolean).map((s) => `   •   ${s}`).join(''), size: 9, color: MUTED },
          ],
          { after: 100 },
        );
      if (c.state === 'ok') text += wP('The case ran to the end and every check in it held.');
      else if (c.state === 'planned') text += wP(NOT_RUN_WHY);
      else {
        text += wP([{ text: 'Why: ', bold: true }, { text: explainFailure(c.error) }]);
        if (c.error) text += wP([{ text: c.error.split('\n').slice(0, 14).join('\n'), mono: true, size: 7, color: [0.35, 0.1, 0.1] }], { after: 100 });
      }
      if (c.file) text += wP([{ text: `Evidence: runs/${run.runName ?? ''}/${c.file}`, size: 8, color: MUTED }]);
      const cells: Cell[] = [];
      if (shot) {
        const n = media.push({ name: `word/media/screen${media.length + 1}.jpeg`, data: shot.bytes });
        let wIn = shot.w >= shot.h ? 2.15 : 1.6;
        let hIn = (wIn * shot.h) / shot.w;
        if (hIn > 3.6) {
          wIn = (wIn * 3.6) / hIn;
          hIn = 3.6;
        }
        const imgW = 3400;
        cells.push(
          { width: W - imgW, fill: PANEL, stripe: col, valign: 'top', body: text },
          {
            width: imgW,
            fill: PANEL,
            valign: 'top',
            body: wImage(`rIdImg${n}`, n, Math.round(wIn * EMU_PER_INCH), Math.round(hIn * EMU_PER_INCH)),
          },
        );
      } else cells.push({ width: W, fill: PANEL, stripe: col, valign: 'top', body: text });
      body.push(wTable([cells]));
    });
  }

  const ns =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${ns}><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${wRun({
    text: `tm8  •  Test report  •  ${run.title ?? 'Test run'}  •  page `,
    size: 8,
    color: MUTED,
  })}<w:fldSimple w:instr="PAGE"><w:r><w:rPr><w:color w:val="${hex(MUTED)}"/><w:sz w:val="16"/></w:rPr><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${ns}><w:body>${body.join(
    '',
  )}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:color w:val="${hex(
    INK,
  )}"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-GB"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>${media
    .map(
      (m, i) =>
        `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/screen${i + 1}.jpeg"/>`,
    )
    .join('')}</Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const root = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(
    `Test report · ${run.title ?? 'Test run'}`,
  )}</dc:title><dc:creator>tm8</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`;
  const utf8 = new TextEncoder();
  return zipStore([
    { name: '[Content_Types].xml', data: utf8.encode(types) },
    { name: '_rels/.rels', data: utf8.encode(root) },
    { name: 'docProps/core.xml', data: utf8.encode(core) },
    { name: 'word/document.xml', data: utf8.encode(document) },
    { name: 'word/styles.xml', data: utf8.encode(styles) },
    { name: 'word/footer1.xml', data: utf8.encode(footer) },
    { name: 'word/_rels/document.xml.rels', data: utf8.encode(rels) },
    ...media,
  ]);
}

export const REPORT_MIME: Record<ReportFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
