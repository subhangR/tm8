import { chromium } from '@playwright/test';
const SP='/tmp/claude-110/-home-tm8-projects-tm8/09a140ba-0119-4ae2-b445-0567964c4b28/scratchpad';
const UI='http://127.0.0.1:4681/e2e/attention-dock-harness.html';
const b=await chromium.launch({ args: ['--single-process', '--no-sandbox', '--disable-gpu'] });
const ctx=await b.newContext({viewport:{width:2660,height:680},deviceScaleFactor:2});
const p=await ctx.newPage();
p.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text());});
p.on('pageerror',e=>console.log('PAGEERROR',e.message));
await p.goto(UI,{waitUntil:'load'});
await p.waitForTimeout(1200);

async function geom(tag){
  return await p.evaluate(()=>{
    const out={};
    for(const box of document.querySelectorAll('[data-panel-box]')){
      const name=box.getAttribute('data-panel-box');
      const panel=box.querySelector('[data-testid=entity-detail-panel]');
      const dock=box.querySelector('[data-testid=attention-requests]');
      const bar=box.querySelector('[data-testid=attention-bar]');
      const sheet=box.querySelector('[data-testid=attention-sheet]');
      const pr=panel.getBoundingClientRect();
      const r=x=>x?{t:+(x.getBoundingClientRect().top-pr.top).toFixed(1),b:+(x.getBoundingClientRect().bottom-pr.top).toFixed(1),h:+x.getBoundingClientRect().height.toFixed(1),w:+x.getBoundingClientRect().width.toFixed(1)}:null;
      out[name]={panelH:+pr.height.toFixed(1),dock:r(dock),bar:r(bar),sheet:r(sheet),
        barText:bar?bar.textContent.replace(/\s+/g,' ').trim():null,
        expanded:bar?bar.getAttribute('aria-expanded'):null};
    }
    return out;
  });
}
console.log('--- at rest ---');
console.log(JSON.stringify(await geom(),null,1));
await p.screenshot({path:SP+'/dock-rest.png',animations:'disabled'});

// scroll the doc body and re-measure the bar: pinned means it does not move.
await p.evaluate(()=>{
  const box=document.querySelector('[data-panel-box=settled]');
  // The REAL scroller, found by measurement rather than by class name: the one
  // element inside the panel that actually overflows.
  const all=[...box.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+20);
  const s=all[0];
  if(!s) return 'NO SCROLLER';
  s.scrollTop=s.scrollHeight;
  return s.className+' scrolled to '+s.scrollTop+' of '+s.scrollHeight;
}).then(c=>console.log('scroller:',c));
await p.waitForTimeout(300);
console.log('--- after scrolling the doc body ---');
const g=await geom(); console.log(JSON.stringify(g.settled,null,1));
await p.screenshot({path:SP+'/dock-scrolled.png',animations:'disabled'});

// open the settled dock
await p.locator('[data-panel-box=settled] [data-testid=attention-bar]').click();
await p.waitForTimeout(400);
console.log('--- settled dock opened ---');
const g2=await geom(); console.log(JSON.stringify(g2.settled,null,1));
await p.screenshot({path:SP+'/dock-open.png',animations:'disabled'});

// DARK. Every colour here resolves through a token, so the theme flip is the
// cheapest proof that none of them was written as a literal.
await p.goto(UI+'?theme=dark',{waitUntil:'load'});
await p.waitForTimeout(1200);
console.log('--- dark ---');
console.log(JSON.stringify(await geom(),null,1));
await p.screenshot({path:SP+'/dock-dark.png',animations:'disabled'});
await b.close();
