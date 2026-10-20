// Operator CLI against the bridge database (safe to run while the bridge is up: SQLite WAL).
//   admin.ts set-operator-secret                   store the hash of the operator secret read from stdin (once)
//   admin.ts issue-token <name> [--channel <id>]   operator: revoke the name's tokens and write a new one to its token file
//                                                  (tokens/<name>.token, 0600); prints the path, never the token
//   admin.ts revoke <name>                         operator: revoke every token of a name
// "operator" commands need WA_BRIDGE_OPERATOR_SECRET in the environment, matching secrets/operator-secret.sha256, so an
// agent session that can run this file still can't mint or revoke speaker tokens (OPERATIONS.md › Speaker tokens).
//   admin.ts names [--channel <id>]                list names
//   admin.ts rebrief-media <name>                  print the media briefing update for a chat/session briefed before media
//   admin.ts rebrief-voice <name>                  print the voice-note briefing update (audio in, quoted media, transcripts)
//   admin.ts rebrief-escalation <name>             print the escalation-rule update (blockers go to WhatsApp)
//   admin.ts rebrief-reply <name> [--token-file p] print the reply-rule update for a main chat (every reply goes to WhatsApp;
//                                                  --token-file: where the chat keeps its token, named in the update, never read)
//   admin.ts rebrief-trust <name>                  print the trusted-senders update (TRUSTED label in envelopes)
//   admin.ts rebrief-delegate <name>               print the delegate-by-default update for a main chat (RULE 2)
//   admin.ts rebrief-style <name>                  print the short-reply update (style guidance) for a chat or session
//   admin.ts rebrief-forms <name>                  print the forms update (POST /form: polls and questions in the group)
//   admin.ts api-reference                         print the full Bridge API reference (no token) for the tm8 doc in apiDocId
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { apiReference, rebriefDelegateRule, rebriefEscalation, rebriefForms, rebriefMedia, rebriefReplyRule, rebriefStyle, rebriefTrust, rebriefVoice } from './briefing.js'
import { loadConfig } from './config.js'
import { Store } from './store.js'
import { hashToken, newToken } from './text.js'
import { writeTokenFile } from './tokens.js'

const ROOT = process.env.WA_BRIDGE_ROOT ?? path.resolve(import.meta.dirname, '..')
const cfg = loadConfig(ROOT)
const store = new Store(path.join(ROOT, 'data', 'bridge.sqlite'))
const [cmd, arg] = process.argv.slice(2)
const flag = (f: string) => {
  const i = process.argv.indexOf(f)
  return i > 0 ? process.argv[i + 1] : undefined
}
const channelId = flag('--channel') ?? cfg.channels[0]?.id

function fail(msg: string): never {
  console.error(msg)
  process.exit(2)
}

const SECRET_FILE = path.join(ROOT, 'secrets', 'operator-secret.sha256')
const TOKEN_DIR = process.env.WA_BRIDGE_TOKEN_DIR ?? path.join(ROOT, 'tokens')
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

/** Token minting and revoking are for the operator only: the secret is never on disk, only its hash. */
function requireOperator() {
  let want: string
  try {
    want = fs.readFileSync(SECRET_FILE, 'utf8').trim()
  } catch {
    fail(`${cmd} needs the operator secret, and none is set up: see OPERATIONS.md › Speaker tokens (admin.ts set-operator-secret)`)
  }
  const secret = process.env.WA_BRIDGE_OPERATOR_SECRET
  if (!/^[0-9a-f]{64}$/.test(want)) fail(`${SECRET_FILE} is not a sha256 hash; set it up again (OPERATIONS.md › Speaker tokens)`)
  if (!secret || !crypto.timingSafeEqual(Buffer.from(sha256(secret)), Buffer.from(want))) {
    fail(`${cmd} is operator-only: set WA_BRIDGE_OPERATOR_SECRET (agent sessions must never mint or revoke speaker tokens)`)
  }
}

switch (cmd) {
  case 'set-operator-secret': {
    if (fs.existsSync(SECRET_FILE)) fail(`an operator secret is already set (${SECRET_FILE}); remove that file by hand to replace it`)
    const secret = fs.readFileSync(0, 'utf8').trim()
    if (secret.length < 20) fail('give a secret of at least 20 characters on stdin')
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true, mode: 0o700 })
    fs.writeFileSync(SECRET_FILE, sha256(secret) + '\n', { mode: 0o600 })
    console.log(`stored the operator secret's hash in ${SECRET_FILE}`)
    break
  }
  case 'issue-token': {
    requireOperator()
    if (!arg) fail('usage: issue-token <name> [--channel <id>]')
    if (!cfg.channels.some((c) => c.id === channelId)) fail(`no channel ${channelId} in config.json`)
    const n = store.getName(arg)
    if (arg !== 'operator') {
      if (!n) fail(`no name ${arg}; use an existing name or "operator"`)
      if (n.status === 'ended') fail(`${arg} has ended`)
      if (n.channel_id !== channelId) fail(`${arg} belongs to channel ${n.channel_id}`)
    }
    const token = newToken()
    const file = writeTokenFile(TOKEN_DIR, arg, token)
    store.db.transaction(() => {
      store.revokeTokens(arg)
      store.addToken(hashToken(token), arg, channelId)
    })()
    console.log(`wrote a new token for ${arg} to ${file} (its earlier tokens are revoked)`)
    break
  }
  case 'revoke':
    requireOperator()
    if (!arg) fail('usage: revoke <name>')
    store.revokeTokens(arg)
    console.log(`revoked tokens of ${arg}`)
    break
  case 'names':
    for (const n of store.namesIn(channelId)) console.log([n.name, n.title ?? "", n.kind, n.status, n.teammate ?? '', n.entity_id, n.parent_name ?? ''].join('\t'))
    break
  case 'rebrief-media':
  case 'rebrief-voice':
  case 'rebrief-trust':
  case 'rebrief-forms': {
    const n = arg ? store.getName(arg) : undefined
    if (!n) fail(`usage: ${cmd} <name>`)
    const ch = cfg.channels.find((c) => c.id === n.channel_id)
    if (!ch) fail(`no channel ${n.channel_id} in config.json`)
    console.log(`# post to tm8 ${n.entity_id}`)
    console.log((cmd === 'rebrief-voice' ? rebriefVoice : cmd === 'rebrief-trust' ? rebriefTrust : cmd === 'rebrief-forms' ? rebriefForms : rebriefMedia)({ cfg, ch, name: n.name }))
    break
  }
  case 'rebrief-escalation': {
    const n = arg ? store.getName(arg) : undefined
    if (!n) fail(`usage: ${cmd} <name>`)
    const ch = cfg.channels.find((c) => c.id === n.channel_id)
    if (!ch) fail(`no channel ${n.channel_id} in config.json`)
    console.log(`# post to tm8 ${n.entity_id}`)
    console.log(rebriefEscalation({ cfg, ch, name: n.name, main: n.kind === 'chat', chatId: n.kind === 'chat' ? n.entity_id : null }))
    break
  }
  case 'rebrief-reply': {
    const n = arg ? store.getName(arg) : undefined
    if (!n) fail(`usage: ${cmd} <name>`)
    if (n.kind !== 'chat') fail(`${n.name} is a session; the reply rule is for main chats (sessions get it in their briefing)`)
    const ch = cfg.channels.find((c) => c.id === n.channel_id)
    if (!ch) fail(`no channel ${n.channel_id} in config.json`)
    console.log(`# post to tm8 ${n.entity_id}`)
    console.log(rebriefReplyRule({ cfg, ch, name: n.name, tokenFile: flag('--token-file') }))
    break
  }
  case 'rebrief-delegate': {
    const n = arg ? store.getName(arg) : undefined
    if (!n) fail(`usage: ${cmd} <name>`)
    if (n.kind !== 'chat') fail(`${n.name} is a session; the delegate rule is for main chats`)
    const ch = cfg.channels.find((c) => c.id === n.channel_id)
    if (!ch) fail(`no channel ${n.channel_id} in config.json`)
    console.log(`# post to tm8 ${n.entity_id}`)
    console.log(rebriefDelegateRule({ cfg, ch, name: n.name }))
    break
  }
  case 'rebrief-style': {
    const n = arg ? store.getName(arg) : undefined
    if (!n) fail(`usage: ${cmd} <name>`)
    const ch = cfg.channels.find((c) => c.id === n.channel_id)
    if (!ch) fail(`no channel ${n.channel_id} in config.json`)
    console.log(`# post to tm8 ${n.entity_id}`)
    console.log(rebriefStyle({ cfg, ch, name: n.name }))
    break
  }
  case 'api-reference':
    console.log(apiReference(cfg))
    break
  default:
    fail('commands: api-reference |  set-operator-secret | issue-token <name> [--channel id] | revoke <name> | names [--channel id] | rebrief-media <name> | rebrief-voice <name> | rebrief-escalation <name> | rebrief-reply <name> [--token-file path] | rebrief-delegate <name> | rebrief-style <name> | rebrief-trust <name> | rebrief-forms <name>')
}
