import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMPTY_RUN, type PhoneRunState } from './phoneRun';
import { FONT_WIDTH_TABLES, jpegOf, reportDocx, reportPdf, summarize, zipStore } from './reportFiles';

/* A tiny real JPEG (8x4, baseline) so the image paths run on real bytes. */
const JPEG =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAAEAAgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ACv/2Q==';

/* REPORT_SAMPLE=<dir> writes the sample files there, with real screenshots from <dir>/shots.json when present. */
const sampleDir = process.env.REPORT_SAMPLE;
const shots: string[] =
  sampleDir && existsSync(`${sampleDir}/shots.json`) ? (JSON.parse(readFileSync(`${sampleDir}/shots.json`, 'utf8')) as string[]) : [JPEG, JPEG, JPEG];

const RUN: PhoneRunState = {
  ...EMPTY_RUN,
  title: 'Deep e-commerce test · next-shop',
  device: 'Desktop 1280×800 · Chromium',
  runName: 'web-20261016T115207Z',
  startedAt: '2026-10-16T11:52:07Z',
  cases: [
    { name: 'Home shows products with prices', group: 'Browse', state: 'ok', ms: 1915, file: '01-home-shows-products-with-prices.png', shot: `data:image/jpeg;base64,${shots[0]}` },
    { name: 'Add product to cart, cart shows it', group: 'Cart', state: 'ok', ms: 7282, file: '02-add-product-to-cart-cart-shows-it.png', shot: `data:image/jpeg;base64,${shots[1]}` },
    {
      name: 'Cart quantity up updates total',
      group: 'Cart',
      state: 'fail',
      ms: 19334,
      error:
        "expect(locator).toHaveText(expected) failed\n\nLocator: getByTestId('cart-total')\nExpected string: \"$58.00\"\nReceived string: \"$87.00\"\nTimeout: 5000ms",
      file: '03-cart-quantity-up-updates-total.png',
      shot: `data:image/jpeg;base64,${shots[2]}`,
    },
    { name: 'Checkout reaches the payment step (no real payment)', group: 'Checkout', state: 'planned' },
  ],
  done: { passed: false, total: 4, failed: 1, ms: 28531, finishedAt: '2026-10-16T11:53:01Z' },
};
const META = { app: 'https://github.com/example/next-shop', asked: 'Browse the shop, add to cart, change quantity, reach checkout — no real payment.' };

const text = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

describe('the test report files', () => {
  it('summarizes the run', () => {
    expect(summarize(RUN)).toEqual({ total: 4, passed: 2, failed: 1, notRun: 1, rate: 50, ms: 28531, status: 'FAILED' });
    expect(summarize({ ...RUN, done: null }).status).toBe('INCOMPLETE');
    expect(FONT_WIDTH_TABLES.map((t) => t.length)).toEqual([95, 95]);
  });

  it('reads a screenshot size from its JPEG header and refuses anything else', () => {
    expect(jpegOf(`data:image/jpeg;base64,${JPEG}`)).toMatchObject({ w: 8, h: 4, comps: 1 });
    expect(jpegOf('data:image/png;base64,iVBORw0KGgo=')).toBeNull();
    expect(jpegOf('data:image/jpeg;base64,AAAA')).toBeNull();
  });

  it('builds a PDF with the status, every case and the screenshots, and a valid xref', () => {
    const pdf = reportPdf(RUN, META);
    const s = text(pdf);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(s).toContain('(FAILED)');
    expect(s).toContain('(2 of 4 cases passed)');
    expect(s).toContain('NOT RUN');
    expect(s).toContain('(Why: The text on screen');
    expect(s.match(/\/Subtype \/Image/g)).toHaveLength(3);
    /* Every xref offset points at its object. */
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    const rows = s.slice(xref).split('\n').slice(3).filter((l) => / 00000 n $/.test(l));
    rows.forEach((row, i) => expect(s.slice(Number(row.slice(0, 10)), Number(row.slice(0, 10)) + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });

  it('escapes runner text so it can never close a PDF string', () => {
    const s = text(reportPdf({ ...RUN, title: 'x) Tj /F2 99 Tf (y', cases: [] }, { app: null, asked: null }));
    expect(s).toContain('x\\) Tj /F2 99 Tf \\(y');
  });

  it('builds a Word document: a zip with the parts Word needs and the screenshots', () => {
    const docx = reportDocx(RUN, META);
    const s = text(docx);
    expect(s.startsWith('PK\x03\x04')).toBe(true);
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'word/media/screen3.jpeg'])
      expect(s).toContain(part);
    expect(s).toContain('OVERALL STATUS');
    expect(s).toContain('Expected string: &quot;$58.00&quot;');
    expect(s).not.toContain('<script');
  });

  it('writes a zip any reader can list', () => {
    const z = zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hello') }]);
    const v = new DataView(z.buffer);
    expect(v.getUint32(z.length - 22, true)).toBe(0x06054b50);
    expect(v.getUint16(z.length - 22 + 10, true)).toBe(1);
  });

  it.runIf(Boolean(sampleDir))('writes the sample files', () => {
    mkdirSync(sampleDir!, { recursive: true });
    writeFileSync(`${sampleDir}/sample-test-report.pdf`, reportPdf(RUN, META));
    writeFileSync(`${sampleDir}/sample-test-report.docx`, reportDocx(RUN, META));
  });
});
