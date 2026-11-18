// The pure pieces: mrkdwn conversion and splitting, Slack text rendering, emoji names, failure mapping, sealing.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { describe, test } from 'node:test'
import { Allowlist, OutboundRefused } from '../src/runtime/allowlist.js'
import { slackNameOf, unicodeOf } from '../src/runtime/emoji.js'
import { PermanentError, TooLargeError } from '../src/runtime/errors.js'
import { failure } from '../src/runtime/runtime.js'
import { parseStateKey, seal, unseal } from '../src/runtime/sealed-auth.js'
import { SlackApi, SlackApiError } from '../src/runtime/slack-api.js'
import { fromSlackText, splitMessage, toMrkdwn } from '../src/runtime/text.js'

describe('toMrkdwn', () => {
  const cases: [string, string, string][] = [
    ['bold', 'a **b** and __c__', 'a *b* and *c*'],
    ['italics', 'an *em* word and _this_', 'an _em_ word and _this_'],
    ['bold italics together', '**bold** then *it*', '*bold* then _it_'],
    ['strike', '~~gone~~', '~gone~'],
    ['links', 'see [the docs](https://x.io/a_b?c=1&d=2) now', 'see <https://x.io/a_b?c=1&d=2|the docs> now'],
    ['a link whose label is its url', '[https://x.io](https://x.io)', '<https://x.io>'],
    ['autolink', '<https://x.io>', '<https://x.io>'],
    ['headings', '# Title\n### Sub **x**', '*Title*\n*Sub x*'],
    ['bullets', '- one\n* two\n  + nested', '• one\n• two\n  • nested'],
    ['numbered lists stay', '1. one\n2. two', '1. one\n2. two'],
    ['task lists', '- [ ] todo\n- [x] done', '☐ todo\n☑ done'],
    ['a rule is not a bullet', '---\n* * *', '---\n* * *'],
    ['quotes stay', '> quoted', '&gt; quoted'],
    ['escapes', 'a < b && c > d', 'a &lt; b &amp;&amp; c &gt; d'],
    ['inline code is left alone', 'run `a **b** <c>` now', 'run `a **b** &lt;c&gt;` now'],
    ['fenced code drops the language and is left alone', 'x\n```ts\nconst a = **b** < c\n```\ny **z**', 'x\n```\nconst a = **b** &lt; c\n```\ny *z*'],
    // Link targets that are not web or mail URLs must never become Slack control tokens (they would ping people).
    ['a link to !channel stays text', 'see [here](!channel)', 'see here (!channel)'],
    ['a link to !here stays text', '[x](!here)', 'x (!here)'],
    ['a link to a user group stays text', '[x](!subteam^S123)', 'x (!subteam^S123)'],
    ['a link to a user id stays text', '[boss](@U0123ABC)', 'boss (@U0123ABC)'],
    ['a javascript: link stays text', '[x](javascript:alert(1))', 'x (javascript:alert(1))'],
    ['a bare-target link stays text', '[](!everyone)', '!everyone'],
    ['raw control tokens are escaped', '<!channel> <@U1> <!subteam^S1>', '&lt;!channel&gt; &lt;@U1&gt; &lt;!subteam^S1&gt;'],
    ['a pipe or angle bracket in a URL cannot open a token', '[x](https://a.io/|<!channel)', '<https://a.io/%7C%3C!channel|x>'],
    ['mailto links', '[mail](mailto:a@b.io)', '<mailto:a@b.io|mail>'],
    ['an autolink with a pipe is encoded', '<https://a.io/x|y>', '<https://a.io/x%7Cy>'],
    ['snake_case words are not italics', 'my_var_name and a*b*c', 'my_var_name and a*b*c'],
  ]
  for (const [name, md, out] of cases) test(name, () => assert.equal(toMrkdwn(md), out))
})

describe('splitMessage', () => {
  test('short text is one part', () => assert.deepEqual(splitMessage('hi'), ['hi']))

  test('splits at paragraph, then line, then word, never over the limit', () => {
    const text = ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)].join('\n\n')
    assert.deepEqual(splitMessage(text, 130), ['a'.repeat(60) + '\n\n' + 'b'.repeat(60), 'c'.repeat(60)])
    const words = 'word '.repeat(100).trim()
    for (const p of splitMessage(words, 64)) assert.ok(p.length <= 64 && !p.startsWith(' ') && !p.endsWith(' '))
    const solid = 'x'.repeat(300)
    assert.equal(splitMessage(solid, 100).join(''), solid)
  })

  test('a cut inside a code block closes it and the next part reopens it', () => {
    const code = '```\n' + Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n```'
    const parts = splitMessage(code, 120)
    assert.ok(parts.length > 1)
    for (const p of parts) {
      assert.ok(p.length <= 120, `${p.length}`)
      assert.equal((p.match(/```/g) ?? []).length % 2, 0, p)
    }
  })
})

describe('fromSlackText', () => {
  test('users, channels, groups, specials, links, mailto, escapes', () => {
    const names: Record<string, string> = { U1: 'Priya' }
    const r = fromSlackText('<@U1> <@W2|rahul> <@U9> <#C1|eng> <#C2> <!subteam^S1|@oncall> <!channel> <mailto:a@b.io|a@b.io> <https://x.io> <https://x.io|x> &lt;&amp;&gt;', (id) => names[id] ?? null)
    assert.equal(r.body, '@Priya @rahul @U9 #eng #C2 @oncall @channel a@b.io https://x.io x (https://x.io) <&>')
    assert.deepEqual(r.mentions, ['U1', 'W2', 'U9'])
  })
})

describe('emoji', () => {
  test('the 427 progress set and common ones both ways', () => {
    assert.equal(slackNameOf('📨'), 'incoming_envelope')
    assert.equal(slackNameOf('👀'), 'eyes')
    assert.equal(slackNameOf('✅'), 'white_check_mark')
    assert.equal(slackNameOf('❤️'), 'heart')
    assert.equal(slackNameOf('❤'), 'heart')
    assert.equal(slackNameOf('👍🏽'), '+1::skin-tone-4')
    assert.equal(slackNameOf(':shipit:'), 'shipit')
    assert.equal(slackNameOf('🦩'), null)
    assert.equal(unicodeOf('eyes'), '👀')
    assert.equal(unicodeOf('thumbsup'), '👍')
    assert.equal(unicodeOf('+1::skin-tone-4'), '👍🏽')
    assert.equal(unicodeOf('partyparrot'), ':partyparrot:')
  })
})

describe('failure', () => {
  test('maps errors to the outbox\'s words', () => {
    assert.deepEqual(failure(new SlackApiError('ratelimited', 'chat.postMessage', { retryAfterSec: 30 })), { reason: 'ratelimited', retryable: true, retryAfterSec: 30 })
    assert.deepEqual(failure(new SlackApiError('channel_not_found', 'chat.postMessage')), { reason: 'channel_not_found', retryable: false })
    assert.deepEqual(failure(new SlackApiError('http_503', 'chat.postMessage')), { reason: 'http_503', retryable: true })
    assert.deepEqual(failure(new SlackApiError('network_error', 'chat.postMessage')), { reason: 'network_error', retryable: true })
    assert.deepEqual(failure(new SlackApiError('slack_not_connected', 'text')), { reason: 'slack_not_connected', retryable: true })
    assert.deepEqual(failure(new OutboundRefused('not_connected', 'C9', 'text')), { reason: 'not_connected', retryable: false })
    assert.deepEqual(failure(new TooLargeError(10, 5)), { reason: 'too_large', retryable: false })
    assert.deepEqual(failure(new PermanentError('not_reactable')), { reason: 'not_reactable', retryable: false })
    assert.deepEqual(failure(new Error('attachment download failed: HTTP 503')), { reason: 'attachment download failed: HTTP 503', retryable: true })
  })
})

describe('sealing and the allowlist', () => {
  test('seal round-trips under its key only; a stateKey must be 32 bytes', () => {
    const k = crypto.randomBytes(32)
    const s = seal(k, Buffer.from('xoxb-secret'))
    assert.ok(!s.includes(Buffer.from('xoxb')))
    assert.equal(unseal(k, s).toString(), 'xoxb-secret')
    assert.throws(() => unseal(crypto.randomBytes(32), s))
    assert.throws(() => parseStateKey(Buffer.alloc(16).toString('base64')))
  })

  test('the allowlist keeps channel ids only and refuses posts where the bot cannot send', () => {
    const a = new Allowlist()
    assert.equal(a.allows('C1'), false)
    a.apply({ version: 1, conversationIds: ['C1', 'G1', 'D1', 'U1', 'c1', ''] })
    assert.deepEqual(a.conversationIds(), ['C1', 'G1'])
    a.setCanSend('C1', 'not_a_member')
    assert.throws(() => a.check('C1', 'text'), OutboundRefused)
    assert.doesNotThrow(() => a.check('C1', 'media.fetch'))
    assert.throws(() => a.check('C9', 'media.fetch'), OutboundRefused)
    assert.equal(a.dropped.outboundRefused, 2)
  })

  test('the bot token is only ever sent to files.slack.com, or the configured base\'s origin (review #5)', () => {
    const real = new SlackApi()
    assert.ok(real.trustsFileHost('https://files.slack.com/files-pri/T1-F1/x.png'))
    assert.ok(real.trustsFileHost('https://files.slack.com:443/files-pri/T1-F1/x.png'))
    for (const bad of [
      'https://acme.enterprise.slack.com/files-pri/x', 'https://slack.com/files-pri/x', 'https://evil.slack.com/x', 'https://a.slack-edge.com/x',
      'https://evil.example/files.slack.com/x', 'http://files.slack.com/x', 'https://files.slack.com.evil.example/x', 'https://files.slack.com:8443/x',
      'https://u:p@files.slack.com/x', 'not a url',
    ]) assert.ok(!real.trustsFileHost(bad), bad)
    const fake = new SlackApi('http://127.0.0.1:9999/api/')
    assert.ok(fake.trustsFileHost('http://127.0.0.1:9999/files-pri/x'))
    assert.ok(!fake.trustsFileHost('http://127.0.0.1:9998/files-pri/x'))
    assert.ok(!fake.trustsFileHost('https://files.slack.com.evil/x'))
  })
})
