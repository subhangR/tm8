// Voice-note transcription. Pluggable by config (transcription.provider); "local" runs whisper.cpp on this machine so
// audio never leaves the box, "none" turns it off. Core calls these one at a time (see Bridge.transcribe).
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Config } from './config.js'

export type TranscriptResult = {
  text: string
  /** ISO 639-1 code whisper detected (or was told), e.g. "en", "hi". */
  lang: string | null
  /** Length of the decoded audio. */
  durationSec: number | null
}

export type TranscribeOptions = {
  /** Kill the run (decode + model) after this long. */
  timeoutMs: number
  /** Refuse audio longer than this (TooLongError). */
  maxDurationSec: number
}

export interface Transcriber {
  /** "local", "none", … (stored with each transcript). */
  readonly provider: string
  /** False for "none": nothing is attempted and envelopes carry no transcript line. */
  readonly enabled: boolean
  transcribe(absPath: string, o: TranscribeOptions): Promise<TranscriptResult>
}

export class TooLongError extends Error {
  constructor(public durationSec: number, public maxSec: number) {
    super(`audio is ${Math.round(durationSec)} s, over the ${maxSec} s transcription limit`)
  }
}
export class TimeoutError extends Error {
  constructor(public ms: number) {
    super(`transcription timed out after ${Math.round(ms / 1000)} s`)
  }
}

/** Timeout for one run: 2× the audio length + 30 s (unknown length: as if it were the max). */
export function transcribeTimeoutMs(durationSec: number | null | undefined, maxDurationSec: number): number {
  const d = durationSec !== null && durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : maxDurationSec
  return Math.round((2 * d + 30) * 1000)
}

export class NoneTranscriber implements Transcriber {
  readonly enabled = false
  constructor(readonly provider = 'none') {}
  async transcribe(): Promise<TranscriptResult> {
    throw new Error('transcription is turned off (transcription.provider = "none")')
  }
}

/** whisper.cpp (whisper-cli) on 16 kHz mono WAV that ffmpeg decodes from whatever WhatsApp sent (usually Ogg/Opus). */
export class LocalWhisper implements Transcriber {
  readonly provider = 'local'
  readonly enabled = true
  constructor(
    private o: { modelPath: string; whisperBin: string; ffmpegBin: string; threads: number; language: string; tmpDir?: string },
  ) {}

  /** Why it can't run (missing model file), or null. Checked at start so the log says so once. */
  problem(): string | null {
    return fs.existsSync(this.o.modelPath) ? null : `model ${this.o.modelPath} not found (run scripts/fetch-model.sh)`
  }

  async transcribe(absPath: string, o: TranscribeOptions): Promise<TranscriptResult> {
    const problem = this.problem()
    if (problem) throw new Error(problem)
    const deadline = Date.now() + o.timeoutMs
    const dir = fs.mkdtempSync(path.join(this.o.tmpDir ?? os.tmpdir(), `wa-stt-${crypto.randomBytes(3).toString('hex')}-`))
    try {
      const wav = path.join(dir, 'in.wav')
      // Decode one second past the cap, so "longer than the cap" is visible without decoding an hour of audio.
      await run(this.o.ffmpegBin, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', absPath, '-t', String(o.maxDurationSec + 1),
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wav], deadline - Date.now(), o.timeoutMs)
      const durationSec = Math.max(0, fs.statSync(wav).size - 44) / 32000
      if (durationSec > o.maxDurationSec) throw new TooLongError(durationSec, o.maxDurationSec)
      if (durationSec < 0.1) return { text: '', lang: null, durationSec }
      const out = path.join(dir, 'out')
      await run(this.o.whisperBin, ['-m', this.o.modelPath, '-f', wav, '-l', this.o.language, '-t', String(this.o.threads),
        '-np', '-nt', '-oj', '-of', out], deadline - Date.now(), o.timeoutMs)
      const j = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'))
      const text = (j.transcription ?? []).map((s: { text?: string }) => s.text ?? '').join('').replace(/\s+/g, ' ').trim()
      return { text, lang: typeof j.result?.language === 'string' ? j.result.language : null, durationSec }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** Run a command; reject on non-zero exit (with the stderr tail) or when `ms` runs out (TimeoutError after a SIGKILL). */
function run(bin: string, args: string[], ms: number, totalMs: number): Promise<void> {
  if (ms <= 0) return Promise.reject(new TimeoutError(totalMs))
  return new Promise((resolve, reject) => {
    // Own process group, so a timeout kills everything the binary started.
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: true })
    let err = ''
    p.stderr.on('data', (c: Buffer) => {
      err = (err + c.toString()).slice(-2000)
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-p.pid!, 'SIGKILL')
      } catch {
        p.kill('SIGKILL')
      }
    }, ms)
    p.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`${path.basename(bin)}: ${e.message}`))
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return reject(new TimeoutError(totalMs))
      if (code === 0) return resolve()
      reject(new Error(`${path.basename(bin)} exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`))
    })
  })
}

/** The configured provider. "openai" is reserved in the config shape but not implemented: it behaves as "none". */
export function makeTranscriber(cfg: Config, root: string, log: (m: string) => void): Transcriber {
  const t = cfg.transcription
  if (t.provider === 'local') {
    const lw = new LocalWhisper({
      modelPath: path.resolve(root, t.modelsDir, t.model), whisperBin: t.whisperBin, ffmpegBin: t.ffmpegBin, threads: t.threads, language: t.language,
    })
    const problem = lw.problem()
    log(`[stt] local whisper.cpp, model ${t.model}, ${t.threads} threads${problem ? `: WARNING ${problem}; voice notes will not be transcribed` : ''}`)
    return lw
  }
  if (t.provider !== 'none') log(`[stt] transcription provider "${t.provider}" is not implemented; transcription is off`)
  return new NoneTranscriber(t.provider === 'none' ? 'none' : `${t.provider} (not implemented)`)
}
