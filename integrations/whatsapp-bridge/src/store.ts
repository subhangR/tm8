// SQLite store: message log + FTS5, channels/epochs, names, speaker tokens, outbox, routes (watchdog).
import Database from 'better-sqlite3'

export type MessageRow = {
  wa_msg_id: string
  channel_id: string | null
  chat_jid: string
  sender_jid: string | null
  sender_alt_jid: string | null
  sender_name: string | null
  text: string
  quoted_wa_msg_id: string | null
  ts: number
  from_me: number
  from_bridge: number
  by_name: string | null
  key_json: string | null
  message_json: string | null
}

export type NameRow = {
  name: string
  space_id: string
  entity_id: string
  kind: 'chat' | 'session'
  teammate: string | null
  channel_id: string
  parent_name: string | null
  status: 'live' | 'ended'
  briefed_at: number | null
  created_at: number
  ended_at: number | null
  /** Short "what it's working on" title shown as `Title (handle)`; from the task/session title or the session's label. */
  title: string | null
  title_source: 'default' | 'label' | null
}

export type OutboxRow = {
  id: number
  idempotency_key: string | null
  name: string
  channel_id: string
  text: string
  reply_to: string | null
  wa_msg_id: string | null
  message_json: string | null
  status: 'queued' | 'sent' | 'failed'
  kind: 'text' | 'react' | 'media'
  /** For kind 'media': JSON of OutboxMedia. `text` is then the caption line. */
  media_json: string | null
  created_at: number
  sent_at: number | null
}

/** A queued media send: the bytes wait in data/media/<path> until WhatsApp takes them. */
export type OutboxMedia = { kind: 'image' | 'document'; mime: string; file_name: string; size: number; path: string; tm8_file_id: string | null }

export type MediaRow = {
  wa_msg_id: string
  channel_id: string
  direction: 'in' | 'out'
  kind: string
  mime: string | null
  file_name: string | null
  caption: string | null
  /** Bytes on disk (null until downloaded); declared_size is what WhatsApp announced. */
  size: number | null
  declared_size: number | null
  /** File name under data/media. */
  path: string | null
  status: 'pending' | 'downloaded' | 'failed' | 'too_large'
  attempts: number
  error: string | null
  /** Serialized download reference (WhatsApp message) for retries. */
  ref_json: string | null
  tm8_file_id: string | null
  /** Audio: length in seconds (WhatsApp's, else the decoded length) and whether it is a voice note (ptt). */
  duration_sec: number | null
  ptt: number | null
  /** Audio transcription: null = never tried; 'disabled' = provider "none". */
  transcript_status: 'pending' | 'done' | 'failed' | 'too_long' | 'disabled' | null
  transcript: string | null
  transcript_lang: string | null
  transcript_provider: string | null
  transcript_error: string | null
  /** How long the transcription took. */
  transcript_ms: number | null
  created_at: number
  updated_at: number | null
}

export type RouteRow = {
  id: number
  wa_msg_id: string
  channel_id: string
  target_name: string
  status: 'pending' | 'posted' | 'replied' | 'warned' | 'failed'
  posted_at: number | null
  replied_at: number | null
  created_at: number
}

export type ChannelRow = { id: string; main_chat_id: string | null; epoch: number; pending_mutation_id: string | null }

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    wa_msg_id TEXT PRIMARY KEY,
    chat_jid TEXT NOT NULL,
    sender_jid TEXT,
    sender_alt_jid TEXT,
    sender_name TEXT,
    text TEXT,
    quoted_wa_msg_id TEXT,
    ts INTEGER,
    from_me INTEGER NOT NULL,
    from_bridge INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    main_chat_id TEXT,
    epoch INTEGER NOT NULL DEFAULT 0,
    pending_mutation_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS epochs (
    channel_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, epoch)
  );
  CREATE TABLE IF NOT EXISTS names (
    name TEXT PRIMARY KEY,
    space_id TEXT NOT NULL,
    entity_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('chat', 'session')),
    teammate TEXT,
    channel_id TEXT NOT NULL,
    parent_name TEXT,
    status TEXT NOT NULL DEFAULT 'live',
    briefed_at INTEGER,
    created_at INTEGER NOT NULL,
    ended_at INTEGER,
    UNIQUE (space_id, name)
  );
  -- Names are never deleted, so a name is never reused; this trigger makes that a hard rule.
  CREATE TRIGGER IF NOT EXISTS names_no_delete BEFORE DELETE ON names
    BEGIN SELECT RAISE(ABORT, 'names are never deleted'); END;
  CREATE TABLE IF NOT EXISTS tokens (
    hash TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS outbox_v1 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT,
    name TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to TEXT,
    wa_msg_id TEXT UNIQUE,
    message_json TEXT,
    status TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    created_at INTEGER NOT NULL,
    sent_at INTEGER,
    UNIQUE (name, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wa_msg_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    target_name TEXT NOT NULL,
    status TEXT NOT NULL,
    posted_at INTEGER,
    replied_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (wa_msg_id, target_name)
  );
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS media (
    wa_msg_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    kind TEXT NOT NULL,
    mime TEXT,
    file_name TEXT,
    caption TEXT,
    size INTEGER,
    declared_size INTEGER,
    path TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    ref_json TEXT,
    tm8_file_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  );
`

export class Store {
  db: Database.Database
  constructor(file: string, private now: () => number = Date.now) {
    this.db = new Database(file)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  private migrate() {
    const cols = new Set((this.db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[]).map((c) => c.name))
    for (const [c, t] of [['channel_id', 'TEXT'], ['by_name', 'TEXT'], ['key_json', 'TEXT'], ['message_json', 'TEXT']] as const) {
      if (!cols.has(c)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${c} ${t}`)
    }
    const nameCols = new Set((this.db.prepare(`PRAGMA table_info(names)`).all() as { name: string }[]).map((c) => c.name))
    for (const c of ['title', 'title_source']) if (!nameCols.has(c)) this.db.exec(`ALTER TABLE names ADD COLUMN ${c} TEXT`)
    const outCols = new Set((this.db.prepare(`PRAGMA table_info(outbox_v1)`).all() as { name: string }[]).map((c) => c.name))
    if (!outCols.has('media_json')) this.db.exec(`ALTER TABLE outbox_v1 ADD COLUMN media_json TEXT`)
    const mediaCols = new Set((this.db.prepare(`PRAGMA table_info(media)`).all() as { name: string }[]).map((c) => c.name))
    for (const [c, t] of [
      ['duration_sec', 'REAL'], ['ptt', 'INTEGER'], ['transcript_status', 'TEXT'], ['transcript', 'TEXT'], ['transcript_lang', 'TEXT'],
      ['transcript_provider', 'TEXT'], ['transcript_error', 'TEXT'], ['transcript_ms', 'INTEGER'],
    ] as const) {
      if (!mediaCols.has(c)) this.db.exec(`ALTER TABLE media ADD COLUMN ${c} ${t}`)
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_channel_ts ON messages(channel_id, ts)`)
    const hasFts = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'`).get()
    if (!hasFts) {
      this.db.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(text, sender_name, content='messages', content_rowid='rowid', tokenize='unicode61');
        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, text, sender_name) VALUES (new.rowid, new.text, new.sender_name);
        END;
        CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text, sender_name) VALUES ('delete', old.rowid, old.text, old.sender_name);
        END;
        CREATE TRIGGER messages_au AFTER UPDATE OF text, sender_name ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, text, sender_name) VALUES ('delete', old.rowid, old.text, old.sender_name);
          INSERT INTO messages_fts(rowid, text, sender_name) VALUES (new.rowid, new.text, new.sender_name);
        END;
        INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
      `)
    }
  }

  /** Phase 0 rows predate channels; attach them to the channel whose JIDs they were logged under. */
  backfillChannel(channelId: string, jids: string[]) {
    const stmt = this.db.prepare(`UPDATE messages SET channel_id = ? WHERE channel_id IS NULL AND chat_jid = ?`)
    for (const j of jids) stmt.run(channelId, j)
  }

  // ---- kv ----
  getKv(k: string): string | null {
    return (this.db.prepare(`SELECT v FROM kv WHERE k = ?`).get(k) as { v: string } | undefined)?.v ?? null
  }
  setKv(k: string, v: string) {
    this.db.prepare(`INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v)
  }

  // ---- messages ----
  /** Insert a message; returns true if it was new. */
  insertMessage(m: Omit<MessageRow, 'by_name'> & { by_name?: string | null }): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO messages
          (wa_msg_id, channel_id, chat_jid, sender_jid, sender_alt_jid, sender_name, text, quoted_wa_msg_id, ts, from_me, from_bridge, by_name, key_json, message_json)
         VALUES (@wa_msg_id, @channel_id, @chat_jid, @sender_jid, @sender_alt_jid, @sender_name, @text, @quoted_wa_msg_id, @ts, @from_me, @from_bridge, @by_name, @key_json, @message_json)`,
      )
      .run({ by_name: null, ...m })
    return r.changes === 1
  }
  /** Record our own send in the log (the WA echo may already have logged it). */
  upsertBridgeMessage(m: Omit<MessageRow, 'from_bridge'>) {
    this.db
      .prepare(
        `INSERT INTO messages
          (wa_msg_id, channel_id, chat_jid, sender_jid, sender_alt_jid, sender_name, text, quoted_wa_msg_id, ts, from_me, from_bridge, by_name, key_json, message_json)
         VALUES (@wa_msg_id, @channel_id, @chat_jid, @sender_jid, @sender_alt_jid, @sender_name, @text, @quoted_wa_msg_id, @ts, @from_me, 1, @by_name, @key_json, @message_json)
         ON CONFLICT(wa_msg_id) DO UPDATE SET from_bridge = 1, by_name = excluded.by_name, channel_id = excluded.channel_id,
           key_json = COALESCE(messages.key_json, excluded.key_json), message_json = COALESCE(messages.message_json, excluded.message_json)`,
      )
      .run(m)
  }
  /** Rewrite a message's log text (FTS follows via the update trigger), e.g. to add a voice note's transcript. */
  setMessageText(id: string, text: string) {
    this.db.prepare(`UPDATE messages SET text = ? WHERE wa_msg_id = ?`).run(text, id)
  }
  getMessage(id: string): MessageRow | undefined {
    return this.db.prepare(`SELECT * FROM messages WHERE wa_msg_id = ?`).get(id) as MessageRow | undefined
  }
  /** Page backwards through a channel's log. `before` is a wa_msg_id cursor. Returns newest-first. */
  history(channelId: string, limit: number, before?: string): MessageRow[] {
    if (before) {
      const b = this.db.prepare(`SELECT rowid, ts FROM messages WHERE wa_msg_id = ? AND channel_id = ?`).get(before, channelId) as
        | { rowid: number; ts: number }
        | undefined
      if (!b) return []
      return this.db
        .prepare(
          `SELECT * FROM messages WHERE channel_id = ? AND (ts < ? OR (ts = ? AND rowid < ?)) ORDER BY ts DESC, rowid DESC LIMIT ?`,
        )
        .all(channelId, b.ts, b.ts, b.rowid, limit) as MessageRow[]
    }
    return this.db
      .prepare(`SELECT * FROM messages WHERE channel_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?`)
      .all(channelId, limit) as MessageRow[]
  }
  search(channelId: string, q: string, opts: { from?: string; since?: number; limit: number }): MessageRow[] {
    // Quote every term so user text can never be FTS5 syntax.
    const terms = q.match(/[\p{L}\p{N}_]+/gu) ?? []
    if (terms.length === 0) return []
    const match = terms.map((t) => `"${t}"`).join(' ')
    const params: unknown[] = [match, channelId]
    let where = ''
    if (opts.from) {
      where += ` AND (m.sender_name LIKE ? OR m.sender_jid LIKE ? OR m.sender_alt_jid LIKE ? OR m.by_name = ?)`
      const like = `%${opts.from}%`
      params.push(like, like, like, opts.from)
    }
    if (opts.since) {
      where += ` AND m.ts >= ?`
      params.push(opts.since)
    }
    params.push(opts.limit)
    return this.db
      .prepare(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
         WHERE messages_fts MATCH ? AND m.channel_id = ?${where} ORDER BY m.ts DESC LIMIT ?`,
      )
      .all(...params) as MessageRow[]
  }

  // ---- channels / epochs ----
  channel(id: string): ChannelRow {
    this.db.prepare(`INSERT OR IGNORE INTO channels (id, epoch, created_at) VALUES (?, 0, ?)`).run(id, this.now())
    return this.db.prepare(`SELECT id, main_chat_id, epoch, pending_mutation_id FROM channels WHERE id = ?`).get(id) as ChannelRow
  }
  setPendingMutation(id: string, mutationId: string | null) {
    this.db.prepare(`UPDATE channels SET pending_mutation_id = ? WHERE id = ?`).run(mutationId, id)
  }
  setMainChat(channelId: string, chatId: string, name: string): number {
    return this.db.transaction(() => {
      const ch = this.channel(channelId)
      const epoch = ch.epoch + 1
      this.db.prepare(`UPDATE channels SET main_chat_id = ?, epoch = ?, pending_mutation_id = NULL WHERE id = ?`).run(chatId, epoch, channelId)
      this.db.prepare(`INSERT INTO epochs (channel_id, epoch, chat_id, name, created_at) VALUES (?, ?, ?, ?, ?)`).run(channelId, epoch, chatId, name, this.now())
      return epoch
    })()
  }
  epochs(channelId: string): { epoch: number; chat_id: string; name: string }[] {
    return this.db.prepare(`SELECT epoch, chat_id, name FROM epochs WHERE channel_id = ? ORDER BY epoch`).all(channelId) as any
  }

  // ---- names ----
  nameTaken = (name: string) => !!this.db.prepare(`SELECT 1 FROM names WHERE name = ?`).get(name)
  insertName(n: Omit<NameRow, 'created_at' | 'ended_at' | 'briefed_at' | 'status' | 'title' | 'title_source'> & { status?: NameRow['status']; title?: string | null }) {
    this.db
      .prepare(
        `INSERT INTO names (name, space_id, entity_id, kind, teammate, channel_id, parent_name, status, created_at, title, title_source)
         VALUES (@name, @space_id, @entity_id, @kind, @teammate, @channel_id, @parent_name, @status, @created_at, @title, @title_source)`,
      )
      .run({ status: 'live', ...n, title: n.title ?? null, title_source: n.title ? 'default' : null, created_at: this.now() })
  }
  /** Set a name's title. A default never overwrites an existing title; a label (the session's own choice) always wins. */
  setTitle(name: string, title: string, source: 'default' | 'label') {
    const where = source === 'default' ? ' AND title IS NULL' : ''
    this.db.prepare(`UPDATE names SET title = ?, title_source = ? WHERE name = ?${where}`).run(title, source, name)
  }
  getName(name: string): NameRow | undefined {
    return this.db.prepare(`SELECT * FROM names WHERE name = ?`).get(name) as NameRow | undefined
  }
  nameByEntity(entityId: string): NameRow | undefined {
    return this.db.prepare(`SELECT * FROM names WHERE entity_id = ?`).get(entityId) as NameRow | undefined
  }
  namesIn(channelId: string): NameRow[] {
    return this.db.prepare(`SELECT * FROM names WHERE channel_id = ? ORDER BY created_at`).all(channelId) as NameRow[]
  }
  markBriefed(name: string) {
    this.db.prepare(`UPDATE names SET briefed_at = ? WHERE name = ?`).run(this.now(), name)
  }
  endName(name: string) {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE names SET status = 'ended', ended_at = ? WHERE name = ? AND status != 'ended'`).run(this.now(), name)
      this.revokeTokens(name)
    })()
  }

  // ---- tokens ----
  addToken(hash: string, name: string, channelId: string) {
    this.db.prepare(`INSERT INTO tokens (hash, name, channel_id, created_at) VALUES (?, ?, ?, ?)`).run(hash, name, channelId, this.now())
  }
  tokenLookup(hash: string): { name: string; channel_id: string } | undefined {
    return this.db.prepare(`SELECT name, channel_id FROM tokens WHERE hash = ? AND revoked_at IS NULL`).get(hash) as any
  }
  revokeTokens(name: string) {
    this.db.prepare(`UPDATE tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL`).run(this.now(), name)
  }

  // ---- outbox ----
  outboxByKey(name: string, key: string): OutboxRow | undefined {
    return this.db.prepare(`SELECT * FROM outbox_v1 WHERE name = ? AND idempotency_key = ?`).get(name, key) as OutboxRow | undefined
  }
  outboxByWaId(id: string): OutboxRow | undefined {
    return this.db.prepare(`SELECT * FROM outbox_v1 WHERE wa_msg_id = ?`).get(id) as OutboxRow | undefined
  }
  /** True if we sent this WA message (Phase 0's outbox included). */
  isOurs(id: string): boolean {
    if (this.outboxByWaId(id)) return true
    const v0 = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'outbox'`).get()
    return !!v0 && !!this.db.prepare(`SELECT 1 FROM outbox WHERE wa_msg_id = ?`).get(id)
  }
  /** Stored WA message proto for a message we sent (for Baileys retries). */
  sentMessageJson(id: string): string | null {
    const r = this.outboxByWaId(id)
    if (r?.message_json) return r.message_json
    const v0 = this.db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'outbox'`).get()
    if (!v0) return null
    return (this.db.prepare(`SELECT message_json FROM outbox WHERE wa_msg_id = ?`).get(id) as any)?.message_json ?? null
  }
  insertOutbox(r: { idempotency_key: string | null; name: string; channel_id: string; text: string; reply_to: string | null; kind?: OutboxRow['kind']; media?: OutboxMedia }): number {
    const { media, ...rest } = r
    return Number(
      this.db
        .prepare(
          `INSERT INTO outbox_v1 (idempotency_key, name, channel_id, text, reply_to, status, kind, media_json, created_at)
           VALUES (@idempotency_key, @name, @channel_id, @text, @reply_to, 'queued', @kind, @media_json, @created_at)`,
        )
        .run({ kind: media ? 'media' : 'text', ...rest, media_json: media ? JSON.stringify(media) : null, created_at: this.now() }).lastInsertRowid,
    )
  }
  setOutboxMedia(id: number, media: OutboxMedia) {
    this.db.prepare(`UPDATE outbox_v1 SET media_json = ? WHERE id = ?`).run(JSON.stringify(media), id)
  }

  // ---- media ----
  insertMedia(m: Pick<MediaRow, 'wa_msg_id' | 'channel_id' | 'direction' | 'kind' | 'mime' | 'file_name' | 'caption' | 'declared_size' | 'ref_json'> &
    Partial<Pick<MediaRow, 'size' | 'path' | 'status' | 'tm8_file_id' | 'duration_sec' | 'ptt'>>): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO media (wa_msg_id, channel_id, direction, kind, mime, file_name, caption, size, declared_size, path, status, ref_json, tm8_file_id, duration_sec, ptt, created_at)
         VALUES (@wa_msg_id, @channel_id, @direction, @kind, @mime, @file_name, @caption, @size, @declared_size, @path, @status, @ref_json, @tm8_file_id, @duration_sec, @ptt, @created_at)`,
      )
      .run({ size: null, path: null, status: 'pending', tm8_file_id: null, duration_sec: null, ptt: null, ...m, created_at: this.now() })
    return r.changes === 1
  }
  getMedia(id: string): MediaRow | undefined {
    return this.db.prepare(`SELECT * FROM media WHERE wa_msg_id = ?`).get(id) as MediaRow | undefined
  }
  updateMedia(
    id: string,
    p: Partial<Pick<MediaRow, 'status' | 'size' | 'path' | 'mime' | 'error' | 'attempts' | 'tm8_file_id' | 'duration_sec' | 'ptt' | 'ref_json' |
      'transcript_status' | 'transcript' | 'transcript_lang' | 'transcript_provider' | 'transcript_error' | 'transcript_ms'>>,
  ) {
    const cols = Object.keys(p)
    if (cols.length === 0) return
    this.db.prepare(`UPDATE media SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @t WHERE wa_msg_id = @id`).run({ ...p, t: this.now(), id })
  }
  /** Inbound media whose download failed and may be retried. */
  retryableMedia(maxAttempts: number, since: number): MediaRow[] {
    return this.db
      .prepare(`SELECT * FROM media WHERE direction = 'in' AND status IN ('pending', 'failed') AND attempts < ? AND created_at >= ? ORDER BY created_at`)
      .all(maxAttempts, since) as MediaRow[]
  }
  markSent(id: number, waId: string, messageJson: string | null) {
    this.db.prepare(`UPDATE outbox_v1 SET status = 'sent', wa_msg_id = ?, message_json = ?, sent_at = ? WHERE id = ?`).run(waId, messageJson, this.now(), id)
  }
  markFailed(id: number) {
    this.db.prepare(`UPDATE outbox_v1 SET status = 'failed' WHERE id = ?`).run(id)
  }
  getOutbox(id: number): OutboxRow | undefined {
    return this.db.prepare(`SELECT * FROM outbox_v1 WHERE id = ?`).get(id) as OutboxRow | undefined
  }
  queued(): OutboxRow[] {
    return this.db.prepare(`SELECT * FROM outbox_v1 WHERE status = 'queued' ORDER BY id`).all() as OutboxRow[]
  }
  /** Idempotency keys live 24 h; after that a repeat key is a new message. */
  expireIdempotencyKeys() {
    this.db.prepare(`UPDATE outbox_v1 SET idempotency_key = NULL WHERE idempotency_key IS NOT NULL AND created_at < ?`).run(this.now() - 24 * 3600_000)
  }

  // ---- routes ----
  insertRoute(waId: string, channelId: string, target: string): number | null {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO routes (wa_msg_id, channel_id, target_name, status, created_at) VALUES (?, ?, ?, 'pending', ?)`)
      .run(waId, channelId, target, this.now())
    return r.changes ? Number(r.lastInsertRowid) : null
  }
  setRouteStatus(id: number, status: RouteRow['status']) {
    const col = status === 'posted' ? ', posted_at = @t' : status === 'replied' ? ', replied_at = @t' : ''
    this.db.prepare(`UPDATE routes SET status = @status${col} WHERE id = @id`).run({ id, status, t: this.now() })
  }
  routesTo(target: string, waId: string): RouteRow | undefined {
    return this.db.prepare(`SELECT * FROM routes WHERE target_name = ? AND wa_msg_id = ?`).get(target, waId) as RouteRow | undefined
  }
  oldestOpenRoute(target: string): RouteRow | undefined {
    return this.db
      .prepare(`SELECT * FROM routes WHERE target_name = ? AND status IN ('posted', 'warned') ORDER BY id LIMIT 1`)
      .get(target) as RouteRow | undefined
  }
  overdueRoutes(olderThan: number): RouteRow[] {
    return this.db.prepare(`SELECT * FROM routes WHERE status = 'posted' AND posted_at < ?`).all(olderThan) as RouteRow[]
  }
  routesFor(waId: string): RouteRow[] {
    return this.db.prepare(`SELECT * FROM routes WHERE wa_msg_id = ?`).all(waId) as RouteRow[]
  }
  lastRoute(target: string): RouteRow | undefined {
    return this.db.prepare(`SELECT * FROM routes WHERE target_name = ? ORDER BY id DESC LIMIT 1`).get(target) as RouteRow | undefined
  }
}
