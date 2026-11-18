// A Slack connection's tokens, sealed at rest (D38, as WhatsApp's device keys): one file per connection,
// AES-256-GCM under the key the server hands over in `connect`/`hello` (never written to disk here). Directory 0700,
// file 0600, written to a temp file and renamed so a crash never leaves a torn file. The tokens never leave this
// module except to call Slack: no frame, log line or error message carries them.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const MAGIC = Buffer.from('tm8s1')
const FILE = 'tokens.seal'

export type SlackTokens = { botToken: string; appToken: string }

export function seal(key: Buffer, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body])
}

export function unseal(key: Buffer, sealed: Buffer): Buffer {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a sealed token file')
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + 12)
  const tag = sealed.subarray(MAGIC.length + 12, MAGIC.length + 28)
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(sealed.subarray(MAGIC.length + 28)), d.final()])
}

export function parseStateKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) throw new Error('stateKey must be 32 bytes, base64')
  return key
}

/** The sealed token store of one connection, in its own directory. */
export class SealedTokens {
  constructor(private dir: string, private key: Buffer) {}

  private get file() {
    return path.join(this.dir, FILE)
  }

  /** The tokens held, or null when none are (or they no longer open under this key). */
  async read(): Promise<SlackTokens | null> {
    const raw = await fs.readFile(this.file).catch(() => null)
    if (!raw) return null
    try {
      const v = JSON.parse(unseal(this.key, raw).toString('utf8')) as Partial<SlackTokens>
      return typeof v.botToken === 'string' && typeof v.appToken === 'string' ? { botToken: v.botToken, appToken: v.appToken } : null
    } catch {
      // A different key (the connection was re-keyed) or a damaged file: nothing usable is held.
      return null
    }
  }

  async write(t: SlackTokens): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    await fs.chmod(this.dir, 0o700)
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
    try {
      await fs.writeFile(tmp, seal(this.key, Buffer.from(JSON.stringify({ botToken: t.botToken, appToken: t.appToken }))), { mode: 0o600 })
      await fs.rename(tmp, this.file)
    } catch (e) {
      await fs.rm(tmp, { force: true })
      throw new Error(`could not seal the tokens: ${(e as NodeJS.ErrnoException).code ?? 'write failed'}`)
    }
  }

  /** Logged out or removed: the tokens must not linger. Empties the directory and keeps the directory itself. */
  async wipe(): Promise<void> {
    for (const f of await fs.readdir(this.dir).catch(() => [])) await fs.rm(path.join(this.dir, f), { recursive: true, force: true })
  }
}
