// Operator CLI against the bridge database (safe to run while the bridge is up: SQLite WAL).
//   admin.ts issue-token <name> [--channel <id>]   print a new speaker token (name: an existing name, or "operator")
//   admin.ts revoke <name>                         revoke every token of a name
//   admin.ts names [--channel <id>]                list names
//   admin.ts rebrief-media <name>                  print the media briefing update for a chat/session briefed before media
//   admin.ts rebrief-voice <name>                  print the voice-note briefing update (audio in, quoted media, transcripts)
//   admin.ts rebrief-escalation <name>             print the escalation-rule update (blockers go to WhatsApp)
//   admin.ts rebrief-reply <name> [--token-file p] print the reply-rule update for a main chat (every reply goes to WhatsApp;
//                                                  --token-file: where the chat keeps its token, named in the update, never read)
//   admin.ts rebrief-delegate <name>               print the delegate-by-default update for a main chat (RULE 2)
import path from 'node:path'
import { rebriefDelegateRule, rebriefEscalation, rebriefMedia, rebriefReplyRule, rebriefVoice } from './briefing.js'
import { loadConfig } from './config.js'
import { Store } from './store.js'
import { hashToken, newToken } from './text.js'

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

switch (cmd) {
  case 'issue-token': {
    if (!arg) fail('usage: issue-token <name> [--channel <id>]')
    if (!cfg.channels.some((c) => c.id === channelId)) fail(`no channel ${channelId} in config.json`)
    const n = store.getName(arg)
    if (arg !== 'operator') {
      if (!n) fail(`no name ${arg}; use an existing name or "operator"`)
      if (n.status === 'ended') fail(`${arg} has ended`)
      if (n.channel_id !== channelId) fail(`${arg} belongs to channel ${n.channel_id}`)
    }
    const token = newToken()
    store.addToken(hashToken(token), arg, channelId)
    console.log(token)
    break
  }
  case 'revoke':
    if (!arg) fail('usage: revoke <name>')
    store.revokeTokens(arg)
    console.log(`revoked tokens of ${arg}`)
    break
  case 'names':
    for (const n of store.namesIn(channelId)) console.log([n.name, n.title ?? "", n.kind, n.status, n.teammate ?? '', n.entity_id, n.parent_name ?? ''].join('\t'))
    break
  case 'rebrief-media':
  case 'rebrief-voice': {
    const n = arg ? store.getName(arg) : undefined
    if (!n) fail(`usage: ${cmd} <name>`)
    const ch = cfg.channels.find((c) => c.id === n.channel_id)
    if (!ch) fail(`no channel ${n.channel_id} in config.json`)
    console.log(`# post to tm8 ${n.entity_id}`)
    console.log((cmd === 'rebrief-voice' ? rebriefVoice : rebriefMedia)({ cfg, ch, name: n.name }))
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
  default:
    fail('commands: issue-token <name> [--channel id] | revoke <name> | names [--channel id] | rebrief-media <name> | rebrief-voice <name> | rebrief-escalation <name> | rebrief-reply <name> [--token-file path] | rebrief-delegate <name>')
}
