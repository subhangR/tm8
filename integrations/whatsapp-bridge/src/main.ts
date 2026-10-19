// wa-bridge Phase 1 entry point: config → store → bridge core → HTTP API → WhatsApp → poller + watchdog.
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.js'
import { Bridge } from './core.js'
import { startHttp } from './http.js'
import { Store } from './store.js'
import { Tm8Cli } from './tm8.js'
import { makeTranscriber } from './transcribe.js'
import { newToken } from './text.js'
import { WaConnection } from './wa.js'

const ROOT = process.env.WA_BRIDGE_ROOT ?? path.resolve(import.meta.dirname, '..')
const AUTH_DIR = path.join(ROOT, 'auth')
const DATA_DIR = path.join(ROOT, 'data')
const allowLink = process.argv.includes('--link')
const listGroups = process.argv.includes('--list-groups')

const cfg = loadConfig(ROOT)
fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(path.join(DATA_DIR, 'home'), { recursive: true })
const store = new Store(path.join(DATA_DIR, 'bridge.sqlite'))
// One tm8 client per (space, token file); a channel's own tm8 block picks its space and token.
const tm8 = (o: { spaceId: string; tokenFile: string; homeSpaceId: string }) => new Tm8Cli({ ...cfg.tm8, ...o, home: path.join(DATA_DIR, 'home') })

// The bridge and the WA connection reference each other; the port is filled in right after.
const waRef: { conn?: WaConnection } = {}
const bridge = new Bridge(cfg, store, {
  connected: () => waRef.conn?.connected() ?? false,
  sendText: (...a) => waRef.conn!.sendText(...a),
  react: (...a) => waRef.conn!.react(...a),
  sendMedia: (...a) => waRef.conn!.sendMedia(...a),
  downloadMedia: (...a) => waRef.conn!.downloadMedia(...a),
}, tm8, {
  mediaDir: path.join(DATA_DIR, 'media'),
  transcriber: makeTranscriber(cfg, ROOT, (m) => console.log(`[${new Date().toISOString()}] ${m}`)),
})
waRef.conn = new WaConnection(bridge, { authDir: AUTH_DIR, dataDir: DATA_DIR, allowLink, listGroups, pairingPhone: cfg.pairingPhone, logLevel: process.env.LOG_LEVEL })

// Operator token for /admin/* (the E2E inject hook). Readable only by tm8: `docker exec wa-bridge cat data/admin-token`.
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, 'admin-token')
if (!fs.existsSync(ADMIN_TOKEN_FILE)) fs.writeFileSync(ADMIN_TOKEN_FILE, newToken() + '\n', { mode: 0o600 })
bridge.adminToken = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim()

process.on('unhandledRejection', (e) => bridge.log(`[unhandled] ${(e as Error)?.stack ?? e}`))

await startHttp(bridge, cfg.http.host, cfg.http.port)
bridge.log(`[http] listening on ${cfg.http.host}:${cfg.http.port}; channels: ${cfg.channels.map((c) => `${c.id}=${c.jid}`).join(', ')}`)
for (const ch of cfg.channels) {
  const c = bridge.clientFor(ch)
  bridge.log(
    `[tm8] ${ch.id}: space ${c.spaceId}${c.viaLink ? ' (through the space link, global token)' : ''}, ` +
      (c.port.configured() ? 'token configured' : `no token at ${c.tokenFile} yet: logging only, mentions get "tm8 link not configured yet"`),
  )
}

await waRef.conn.start()

// --link and --list-groups are one-off operator modes: connect only, no polling, routing timers or main chats.
if (allowLink || listGroups) await new Promise(() => {})

bridge.resumeTranscriptions()

// Every tick polls each channel's space; a channel without a token is skipped (and logged once) without holding up the rest.
const pollTick = () => void bridge.poll()
pollTick()
setInterval(pollTick, cfg.tm8.pollSeconds * 1000)
setInterval(() => void bridge.watchdogTick().catch((e) => bridge.log(`[watchdog] ${e.message}`)), 30_000)
setInterval(() => {
  if (bridge.wa.connected()) void bridge.flushQueue()
}, 15_000)

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    bridge.log(`[exit] ${sig}`)
    store.db.close()
    process.exit(0)
  })
}
