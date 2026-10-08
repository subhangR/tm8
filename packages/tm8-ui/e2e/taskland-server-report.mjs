/** Static, portable evidence view. Input is only the runner's synthetic aggregate. */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export async function writeTasklandReport(directory, evidence) {
  const passed = !evidence.failure && evidence.checks.every(check => check.passed);
  const checks = evidence.checks.map(check => `<tr><td>${check.passed ? 'PASS' : 'FAIL'}</td><td>${escape(check.name)}</td><td>${check.milliseconds} ms</td></tr>`).join('');
  const pictures = evidence.screenshots.map(name => `<figure><img src="${escape(name)}" alt="Rendered synthetic Taskland scene"><figcaption>${escape(name)}</figcaption></figure>`).join('');
  await writeFile(resolve(directory, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Synthetic Taskland acceptance</title><style>body{font:16px system-ui;color:#18251d;background:#edf2ea;margin:2rem auto;padding:0 1rem;max-width:1100px}code{overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;background:white}td{padding:.6rem;border-bottom:1px solid #d0d9cb}td:first-child{font-weight:700}img{max-width:100%;height:auto}figure{margin:2rem 0}small{color:#40533e}</style>
<h1>Synthetic Taskland acceptance: ${passed ? 'passed checks' : 'incomplete'}</h1>
<p>Exact source head <code>${escape(evidence.head)}</code>. Synthetic records only. ${escape(evidence.gpuProof)}.</p>
<p>Tracked source modified: ${evidence.dirty ? 'yes' : 'no'}. Rendered checks skipped: ${evidence.renderSkipped ? 'yes' : 'no'}. Owned processes stopped: ${evidence.ownedProcessesStopped ? 'yes' : 'no'}. Owned database dropped: ${evidence.ownedDatabaseDropped ? 'yes' : 'no'}.</p>
${evidence.failure ? `<p><strong>Open failure:</strong> ${escape(evidence.failure)}</p>` : ''}
<table><tbody>${checks}</tbody></table>
${evidence.unreadLatency ? `<p>Unread HTTP measurement: ${evidence.unreadLatency.anchors} synthetic anchors, ${evidence.unreadLatency.messages} messages, ${evidence.unreadLatency.requests} requests. Median ${evidence.unreadLatency.median.toFixed(1)} ms; maximum ${evidence.unreadLatency.maximum.toFixed(1)} ms.</p>` : ''}
<p><a href="checks.json">Aggregate checks and selected synthetic before/after models</a></p>
${evidence.syntheticReport ? `<p><a href="${escape(evidence.syntheticReport)}">Both-scope synthetic motion frames and actual worker readback</a></p>` : ''}
${pictures}<ul>${evidence.limitations.map(note => `<li>${escape(note)}</li>`).join('')}</ul>
<small>No provider credentials, tokens, private records or raw runtime logs are included.</small></html>`);
}
