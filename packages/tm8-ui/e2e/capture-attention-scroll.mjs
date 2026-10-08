// Run against the same Vite app as attention-scroll.spec.ts. Set
// TM8_EVIDENCE_LABEL=before on the baseline checkout, then after on the fix.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = process.env.TM8_EVIDENCE_DIR ?? 'gate-evidence/attention-scroll';
const label = process.env.TM8_EVIDENCE_LABEL ?? 'after';
const base = process.env.TM8_UI_URL ?? 'http://127.0.0.1:4612';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  ...(process.env.TM8_BROWSER_SINGLE_PROCESS === '1' ? { args: ['--no-zygote', '--single-process', '--disable-gpu'] } : {}),
});
try {
  const page = await browser.newPage();
  const result = [];
  for (const viewport of [{width:800,height:400}, {width:390,height:420}, {width:320,height:240}]) {
    await page.setViewportSize(viewport);
    await page.goto(`${base}/e2e/attention-scroll-harness.html`);
    await page.getByTestId('pending-forms-chip').click();
    const pop = page.getByTestId('pending-forms-popover');
    const focusedOnOpen = await pop.evaluate(el => document.activeElement === el);
    await pop.getByRole('button',{name:'Answer',exact:true}).click();
    await page.getByTestId('question-question_15').waitFor();
    const measure = () => page.locator('.pf-chip__pop, .pf-banner, .pf-banner__list').evaluateAll(es => es.map(el => ({
      className:el.className, clientHeight:el.clientHeight, scrollHeight:el.scrollHeight,
      scrollTop:el.scrollTop, rect:el.getBoundingClientRect().toJSON(),
    })));
    const initial = await measure();
    const box = await pop.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0,600);
    await page.waitForTimeout(300);
    const afterWheel = await measure();
    await page.screenshot({path:`${out}/${label}-${viewport.width}x${viewport.height}.png`});
    result.push({viewport, focusedOnOpen, wheelDeltaY:600, initial, afterWheel});
  }
  writeFileSync(`${out}/${label}-measurements.json`, JSON.stringify(result,null,2));
} finally { await browser.close(); }
