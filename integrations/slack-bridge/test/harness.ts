// The whole runtime against a fake Slack and a fake tm8-server: the real HttpWsLink, Runtime, SlackConnection and
// Socket Mode client, nothing stubbed inside the process.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HttpWsLink } from '../src/runtime/link.js'
import type { AllowlistFrame, ServerFrame } from '../src/runtime/protocol.js'
import { Runtime } from '../src/runtime/runtime.js'
import type { Egress } from '../src/runtime/egress.js'
import { SlackApi } from '../src/runtime/slack-api.js'
import { FakeSlack } from './fake-slack.js'
import { FakeTm8 } from './fake-tm8.js'

export const CONN = '01a1eddf-0000-7000-8000-000000000001'
export const CONN2 = '01a1eddf-0000-7000-8000-000000000002'

export type Rig = Awaited<ReturnType<typeof rig>>

export async function rig(o: { stateDir?: string; key?: Buffer; slack?: FakeSlack; tm8?: FakeTm8; egress?: Egress } = {}) {
  const slack = o.slack ?? (await FakeSlack.start())
  const tm8 = o.tm8 ?? (await FakeTm8.start())
  const stateDir = o.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'slack-rt-'))
  const key = o.key ?? crypto.randomBytes(32)
  const logs: string[] = []
  const log = (m: string) => void logs.push(m)
  const ref: { runtime?: Runtime } = {}
  const link = new HttpWsLink({
    serverUrl: tm8.url,
    runtimeId: 'slack-test',
    token: () => tm8.token,
    log,
    onOpen: () => ref.runtime!.hello(),
    onFrame: (f) => ref.runtime!.onFrame(f),
  })
  const runtime = new Runtime({
    runtimeId: 'slack-test',
    stateDir,
    link,
    log,
    api: new SlackApi(slack.apiUrl, o.egress),
    tuning: { pingMs: 250, backoffMs: () => 30, sharePollMs: 20 },
  })
  ref.runtime = runtime
  const r = {
    slack,
    tm8,
    runtime,
    link,
    stateDir,
    key,
    logs,
    sealedFile: (id = CONN) => path.join(stateDir, 'bridges', id, 'tokens.seal'),
    allowlist: (ids: string[], version = 1, connectionId = CONN): AllowlistFrame => ({ type: 'allowlist', connectionId, version, conversationIds: ids }),
    /** Opens the link and waits for hello and the push socket. */
    async start() {
      link.start()
      await tm8.waitFor('hello')
      await tm8.waitForSocket()
    },
    /** Pastes the fake's tokens on a connect and waits for `linked` and a live Socket Mode socket. */
    async connect(ids: string[] = ['C1', 'G1'], extra: Partial<Extract<ServerFrame, { type: 'connect' }>> = {}) {
      const before = tm8.of('state').length
      tm8.push({ type: 'connect', connectionId: CONN, stateKey: key.toString('base64'), credential: { kind: 'slack_tokens', botToken: slack.botToken, appToken: slack.appToken }, allowlist: r.allowlist(ids), ...extra })
      await waitUntil(() => tm8.of('state').slice(before).some((s) => s.connectionId === CONN && (s.status === 'linked' || s.status === 'logged_out')))
      await slack.waitForSocket()
      return tm8.of('state').slice(before)
    },
    async stop() {
      link.stop()
      await runtime.stop()
      runtime.api.egress.destroy()
      await slack.close()
      await tm8.close()
    },
  }
  return r
}

export async function waitUntil(pred: () => boolean, timeoutMs = 5000, what = 'condition') {
  const end = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Seeds a typical workspace: #eng (C1, connected), #random (C2, not connected), private #secret (G1, connected). */
export function seed(slack: FakeSlack) {
  slack.channel({ id: 'C1', name: 'eng', members: 12 })
  slack.channel({ id: 'C2', name: 'random' })
  slack.channel({ id: 'G1', name: 'secret', private: true })
  slack.user({ id: 'U1', name: 'Priya', realName: 'Priya Shah', email: 'priya@acme.io', avatar: 'https://avatars.slack-edge.com/priya_192.png' })
  slack.user({ id: 'U2', name: 'Rahul', email: null })
}
