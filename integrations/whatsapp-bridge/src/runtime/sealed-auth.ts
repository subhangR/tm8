// A linked device's key material, sealed at rest (§2.5, §6): Baileys' multi-file auth state, but every file is
// AES-256-GCM under a key the server hands over in `connect` (never written to disk here). Directory 0700, files 0600.
import { BufferJSON, initAuthCreds, proto, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const MAGIC = Buffer.from('tm8s1')

export function seal(key: Buffer, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body])
}

export function unseal(key: Buffer, sealed: Buffer): Buffer {
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not a sealed auth file')
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

export async function useSealedAuthState(dir: string, key: Buffer): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; wipe: () => Promise<void> }> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.chmod(dir, 0o700)
  // One write chain per file: Baileys writes the same key files concurrently.
  const chains = new Map<string, Promise<unknown>>()
  const serial = <T>(file: string, fn: () => Promise<T>): Promise<T> => {
    const next = (chains.get(file) ?? Promise.resolve()).then(fn, fn)
    chains.set(file, next.catch(() => {}))
    return next
  }
  const fileOf = (name: string) => path.join(dir, name.replace(/\//g, '__').replace(/:/g, '-') + '.seal')
  // Write a temp file and rename it over the old one: a crash mid-write leaves the previous file whole, never a torn
  // creds.seal that would force the number to be linked again.
  const write = (name: string, data: unknown) =>
    serial(fileOf(name), async () => {
      const tmp = `${fileOf(name)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      try {
        await fs.writeFile(tmp, seal(key, Buffer.from(JSON.stringify(data, BufferJSON.replacer))), { mode: 0o600 })
        await fs.rename(tmp, fileOf(name))
      } catch (e) {
        await fs.rm(tmp, { force: true })
        throw e
      }
    })
  const read = (name: string) =>
    serial(fileOf(name), async () => {
      const raw = await fs.readFile(fileOf(name)).catch(() => null)
      return raw ? JSON.parse(unseal(key, raw).toString('utf8'), BufferJSON.reviver) : null
    })
  const remove = (name: string) => serial(fileOf(name), () => fs.rm(fileOf(name), { force: true }))

  // A crash between a temp write and its rename leaves the temp behind; the renamed-over file is still whole.
  for (const f of await fs.readdir(dir)) if (f.endsWith('.tmp')) await fs.rm(path.join(dir, f), { force: true })
  const creds = (await read('creds')) ?? initAuthCreds()
  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {}
          await Promise.all(
            ids.map(async (id) => {
              let v = await read(`${type}-${id}`)
              if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v)
              out[id] = v
            }),
          )
          return out
        },
        set: async (data) => {
          const tasks: Promise<unknown>[] = []
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            for (const [id, v] of Object.entries(data[category] ?? {})) tasks.push(v ? write(`${category}-${id}`, v) : remove(`${category}-${id}`))
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: () => write('creds', creds).then(() => {}),
    // Logged out or removed: the keys are worthless and must not linger. Empty the directory, keep the directory itself.
    wipe: async () => {
      for (const f of await fs.readdir(dir).catch(() => [])) await fs.rm(path.join(dir, f), { recursive: true, force: true })
    },
  }
}
