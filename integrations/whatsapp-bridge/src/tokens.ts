// Speaker tokens live in 0600 files, one per name; briefings name the file, never the token.
import fs from 'node:fs'
import path from 'node:path'

/** Where a name's token file is: <dir>/<name>.token. */
export function tokenFilePath(dir: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`not a name for a token file: ${JSON.stringify(name)}`)
  return path.join(dir, `${name}.token`)
}

/** Write (or replace) a name's token file atomically, mode 0600 in a 0700 directory. Returns its path. */
export function writeTokenFile(dir: string, name: string, token: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const file = tokenFilePath(dir, name)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, file)
  return file
}

/** A name's token from its file, or null if there is none. */
export function readTokenFile(dir: string, name: string): string | null {
  try {
    return fs.readFileSync(tokenFilePath(dir, name), 'utf8').trim() || null
  } catch {
    return null
  }
}
