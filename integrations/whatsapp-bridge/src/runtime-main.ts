// WhatsApp connector runtime entry point (§2.5): runs beside the Phase-1 bridge (src/main.ts) until the B1c cutover.
//   TM8_SERVER_URL                 tm8-server on loopback (default http://127.0.0.1:17777)
//   TM8_BRIDGE_RUNTIME_TOKEN_FILE  the `bridge_runtime` bearer the node minted for this sidecar (re-read on each call)
//   WA_RUNTIME_ID                  stable id for this runtime (default whatsapp-<hostname>)
//   WA_RUNTIME_DATA_DIR            sealed per-connection key dirs live under <dir>/bridges/<connectionId>/
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { HttpWsLink } from './runtime/link.js'
import { HEARTBEAT_MS, Runtime } from './runtime/runtime.js'

// Node 22 gives each address family 250 ms to connect before failing over (happy eyeballs). From a host where the
// TCP connect to web.whatsapp.com takes longer than that and IPv6 is unreachable, every attempt fails at once
// with ETIMEDOUT, which Baileys reports as "408 WebSocket Error ()" before any QR or pairing code. Seen on prod.
net.setDefaultAutoSelectFamilyAttemptTimeout(Number(process.env.WA_CONNECT_ATTEMPT_TIMEOUT_MS ?? 2000))

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`)
const serverUrl = process.env.TM8_SERVER_URL ?? 'http://127.0.0.1:17777'
const tokenFile = process.env.TM8_BRIDGE_RUNTIME_TOKEN_FILE
if (!tokenFile) throw new Error('TM8_BRIDGE_RUNTIME_TOKEN_FILE is required')
const runtimeId = process.env.WA_RUNTIME_ID ?? `whatsapp-${os.hostname()}`
const dataDir = path.resolve(process.env.WA_RUNTIME_DATA_DIR ?? path.join(import.meta.dirname, '..', 'runtime-data'))
fs.mkdirSync(path.join(dataDir, 'bridges'), { recursive: true, mode: 0o700 })

const ref: { runtime?: Runtime } = {}
const link = new HttpWsLink({
  serverUrl,
  runtimeId,
  token: () => fs.readFileSync(tokenFile, 'utf8').trim(),
  log,
  onOpen: () => ref.runtime!.hello(),
  onFrame: (f) => ref.runtime!.onFrame(f),
})
const runtime = new Runtime({ runtimeId, dataDir, link, log, logLevel: process.env.LOG_LEVEL })
ref.runtime = runtime

process.on('unhandledRejection', (e) => log(`[unhandled] ${(e as Error)?.message ?? e}`))
link.start()
// Three missed heartbeats mark every bridge on this runtime degraded (§2.5); 30 s keeps that inside 90 s (§7.3 item 6).
setInterval(() => void runtime.heartbeat().catch(() => {}), HEARTBEAT_MS)
log(`[runtime] ${runtimeId} → ${serverUrl}, state in ${dataDir}`)

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(`[exit] ${sig}`)
    link.stop()
    void runtime.stop().finally(() => process.exit(0))
  })
}
