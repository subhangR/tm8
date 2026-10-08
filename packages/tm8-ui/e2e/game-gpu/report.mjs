import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { distribution } from './core.mjs';
export async function writeReport(directory, report) {
  const groups = new Map();
  for (const run of report.runs ?? []) for (const window of run.windows ?? []) {
    const key = `${run.key}/${window.interaction}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ repeat: run.repeat, valid: window.valid, fps: window.fps, medianMs: window.frameMs.median, p95Ms: window.frameMs.p95 });
  }
  report.repeatSummaries = [...groups].map(([key, repeats]) => ({ key, repeats,
    validRepeats: repeats.filter(r => r.valid).length,
    fpsSpread: distribution(repeats.filter(r => r.valid).map(r => r.fps)),
    medianMsSpread: distribution(repeats.filter(r => r.valid).map(r => r.medianMs)),
    p95MsSpread: distribution(repeats.filter(r => r.valid).map(r => r.p95Ms)) }));
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Game GPU synthetic baseline</title><link rel="stylesheet" href="style.css"></head><body><h1>Game GPU synthetic baseline</h1><p id="status"></p><p>Rendered frame intervals include CPU scheduling, animation and driver/compositor pacing. Callback CPU time is not GPU execution time. Software results are diagnostic. There is no approved FPS budget.</p><p><a href="report.json">Exact JSON, raw samples and provenance</a> · <a href="reproduce.md">Reproduction instructions</a></p><pre id="provenance"></pre><div class="scroll"><table><thead><tr><th>Case</th><th>Repeat / interaction</th><th>Places / workers</th><th>Readiness ms</th><th>Samples</th><th>FPS</th><th>Frame median / p95 / p99 ms</th><th>Draw median / p95</th><th>Validity / native</th></tr></thead><tbody id="rows"></tbody></table></div><h2>Coverage</h2><pre id="coverage"></pre><script type="module" src="viewer.js"></script></body></html>`);
  await writeFile(join(directory, 'style.css'), 'body{font:15px system-ui;background:#f4f2ec;color:#23201b;margin:24px}h1{font-size:26px}pre{white-space:pre-wrap;overflow-wrap:anywhere}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:8px;text-align:left;border-bottom:1px solid #ccc}th{background:#e7e3d9}a{color:#75420c}');
  await writeFile(join(directory, 'viewer.js'), `const r=await fetch('./report.json').then(r=>r.json());
document.querySelector('#status').textContent=r.nativeEligible?'Native device evidence and sample checks satisfied.':'DIAGNOSTIC / UNVERIFIED — native eligibility false.';
document.querySelector('#provenance').textContent=JSON.stringify({head:r.provenance?.head,main:r.provenance?.main,dirty:r.provenance?.dirty,toolHash:r.provenance?.toolHash,settings:r.settings,audit:r.audit,browser:r.browser},null,2);
const fmt=n=>typeof n==='number'?n.toFixed(2):'—';
for(const row of r.runs??[])for(const w of row.windows??[{}]){const tr=document.createElement('tr');const values=[row.key,row.repeat+' / '+(w.interaction??row.error??'failed'),(row.counts?.places??'—')+' / '+(row.counts?.robots??'—'),fmt(row.readiness?.loadToReadyMs),w.sampledFrames??0,fmt(w.fps),[w.frameMs?.median,w.frameMs?.p95,w.frameMs?.p99].map(fmt).join(' / '),[w.drawCalls?.median,w.drawCalls?.p95].map(fmt).join(' / '),(w.valid?'valid':'invalid')+' / '+(w.eligibility?.nativeEligible??false)];for(const value of values){const td=document.createElement('td');td.textContent=String(value);tr.append(td);}document.querySelector('#rows').append(tr);}
document.querySelector('#coverage').textContent=JSON.stringify({coverage:r.coverage,repeatSummaries:r.repeatSummaries},null,2);`);
}
