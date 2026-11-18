// Unicode emoji ⇄ Slack reaction names. tm8 speaks unicode (WhatsApp's reactions, migration 427's progress set
// 📨 → 👀 → ✅); Slack's reactions.add takes a name and reaction_added gives one. Unknown names arrive as `:name:`
// (custom workspace emoji), and a `:name:` going out is sent as that name.

const TABLE: [string, string][] = [
  // 427's progress reactions.
  ['📨', 'incoming_envelope'], ['👀', 'eyes'], ['✅', 'white_check_mark'],
  // Common.
  ['👍', '+1'], ['👎', '-1'], ['❤️', 'heart'], ['😂', 'joy'], ['😮', 'open_mouth'], ['😢', 'cry'], ['🙏', 'pray'],
  ['🎉', 'tada'], ['🔥', 'fire'], ['🚀', 'rocket'], ['❌', 'x'], ['⚠️', 'warning'], ['💯', '100'], ['👏', 'clap'],
  ['🙌', 'raised_hands'], ['🤔', 'thinking_face'], ['😄', 'smile'], ['😀', 'grinning'], ['😃', 'smiley'], ['😊', 'blush'],
  ['🙂', 'slightly_smiling_face'], ['😍', 'heart_eyes'], ['😅', 'sweat_smile'], ['🤣', 'rolling_on_the_floor_laughing'],
  ['😉', 'wink'], ['😎', 'sunglasses'], ['😭', 'sob'], ['😡', 'rage'], ['😱', 'scream'], ['🙃', 'upside_down_face'],
  ['🥳', 'partying_face'], ['😬', 'grimacing'], ['🤯', 'exploding_head'], ['🫡', 'saluting_face'], ['👋', 'wave'],
  ['👌', 'ok_hand'], ['✌️', 'v'], ['🤝', 'handshake'], ['💪', 'muscle'], ['🫶', 'heart_hands'], ['⭐', 'star'],
  ['✨', 'sparkles'], ['💡', 'bulb'], ['📌', 'pushpin'], ['📎', 'paperclip'], ['📝', 'memo'], ['⏳', 'hourglass_flowing_sand'],
  ['⌛', 'hourglass'], ['✔️', 'heavy_check_mark'], ['☑️', 'ballot_box_with_check'], ['❗', 'exclamation'], ['❓', 'question'],
  ['🐛', 'bug'], ['🛠️', 'hammer_and_wrench'], ['🔧', 'wrench'], ['🚧', 'construction'], ['🛑', 'octagonal_sign'],
  ['🟢', 'large_green_circle'], ['🔴', 'red_circle'], ['🟡', 'large_yellow_circle'], ['🤖', 'robot_face'],
  ['💬', 'speech_balloon'], ['📣', 'mega'], ['🔔', 'bell'], ['👆', 'point_up_2'], ['👉', 'point_right'], ['💥', 'boom'],
  ['🎯', 'dart'], ['📈', 'chart_with_upwards_trend'], ['📉', 'chart_with_downwards_trend'], ['🔁', 'repeat'],
  ['⏰', 'alarm_clock'], ['🙈', 'see_no_evil'], ['💀', 'skull'], ['🤷', 'shrug'], ['🧐', 'face_with_monocle'],
  ['😴', 'sleeping'], ['🍕', 'pizza'], ['☕', 'coffee'], ['🏁', 'checkered_flag'], ['🔒', 'lock'], ['🔑', 'key'],
  ['📦', 'package'], ['🧪', 'test_tube'], ['🆗', 'ok'], ['🆕', 'new'], ['➕', 'heavy_plus_sign'], ['➖', 'heavy_minus_sign'],
]

/** Slack's aliases for the same emoji, read inbound. */
const ALIASES: [string, string][] = [['thumbsup', '👍'], ['thumbsdown', '👎'], ['heavy_check_mark', '✔️'], ['raised_hand', '✋'], ['hourglass', '⌛']]

const VS16 = /️/g
const toName = new Map<string, string>()
const toUnicode = new Map<string, string>()
for (const [u, n] of TABLE) {
  toName.set(u.replace(VS16, ''), n)
  toUnicode.set(n, u)
}
for (const [n, u] of ALIASES) if (!toUnicode.has(n)) toUnicode.set(n, u)

/** The Slack name to react with, or null when this emoji has none we know. */
export function slackNameOf(emoji: string): string | null {
  const e = emoji.trim()
  const custom = /^:([a-z0-9_+'-]+):$/.exec(e)
  if (custom) return custom[1]!
  // Skin tones: Slack writes them as a suffix on the name.
  const tone = /[\u{1F3FB}-\u{1F3FF}]/u.exec(e)
  const base = toName.get(e.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '').replace(VS16, ''))
  if (!base) return null
  return tone ? `${base}::skin-tone-${tone[0].codePointAt(0)! - 0x1f3fb + 2}` : base
}

/** The unicode emoji for a Slack reaction name; `:name:` when it is custom or unknown here. */
export function unicodeOf(name: string): string {
  const [base, tone] = name.split('::')
  const u = toUnicode.get(base!)
  if (!u) return `:${name}:`
  const t = /^skin-tone-([2-6])$/.exec(tone ?? '')
  return t ? u.replace(VS16, '') + String.fromCodePoint(0x1f3fb + Number(t[1]) - 2) : u
}
