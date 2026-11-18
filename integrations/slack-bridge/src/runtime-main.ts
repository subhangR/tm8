// Slack connector runtime entry point (§2.5): one process for every Slack app install on this node.
//   TM8_SERVER_URL                 tm8-server on loopback (default http://127.0.0.1:17777)
//   TM8_BRIDGE_RUNTIME_TOKEN_FILE  the `bridge_runtime` bearer the node minted for this sidecar (re-read on each call)
//   TM8_SLACK_STATE_DIR            sealed tokens live under <dir>/bridges/<connectionId>/ (default ./data)
//   TM8_SLACK_API_URL              Slack Web API base (default https://slack.com/api/); tests point it at a fake
//   TM8_SLACK_RUNTIME_ID           stable id for this runtime (default slack-<hostname>)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HttpWsLink } from './runtime/link.js'
import { HEARTBEAT_MS, Runtime } from './runtime/runtime.js'
import { DEFAULT_SLACK_API_URL, SlackApi } from './runtime/slack-api.js'

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`)
const serverUrl = process.env.TM8_SERVER_URL ?? 'http://127.0.0.1:17777'
const tokenFile = process.env.TM8_BRIDGE_RUNTIME_TOKEN_FILE
if (!tokenFile) {
  console.error('TM8_BRIDGE_RUNTIME_TOKEN_FILE is required')
  process.exit(1)
}
const runtimeId = process.env.TM8_SLACK_RUNTIME_ID ?? `slack-${os.hostname()}`
const stateDir = path.resolve(process.env.TM8_SLACK_STATE_DIR ?? 'data')
const apiUrl = process.env.TM8_SLACK_API_URL ?? DEFAULT_SLACK_API_URL
fs.mkdirSync(path.join(stateDir, 'bridges'), { recursive: true, mode: 0o700 })

const ref: { runtime?: Runtime } = {}
const link = new HttpWsLink({
  serverUrl,
  runtimeId,
  token: () => fs.readFileSync(tokenFile, 'utf8').trim(),
  log,
  onOpen: () => ref.runtime!.hello(),
  onFrame: (f) => ref.runtime!.onFrame(f),
})
const runtime = new Runtime({ runtimeId, stateDir, link, log, api: new SlackApi(apiUrl) })
ref.runtime = runtime

process.on('unhandledRejection', (e) => log(`[unhandled] ${(e as Error)?.message ?? e}`))
link.start()
// Three missed heartbeats mark every bridge on this runtime degraded (§2.5); 30 s keeps that inside 90 s.
setInterval(() => void runtime.heartbeat().catch(() => {}), HEARTBEAT_MS)
log(`[runtime] ${runtimeId} → ${serverUrl}, Slack API ${apiUrl}, state in ${stateDir}`)

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`[exit] ${sig}`)
    link.stop()
    void runtime.stop().finally(() => process.exit(0))
  })
}
