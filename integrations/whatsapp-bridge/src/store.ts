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
  kind: 'text' | 'react' | 'media' | 'poll'
  /** For kind 'media': JSON of OutboxMedia. `text` is then the caption line. */
  media_json: string | null
  /** For kind 'poll': JSON of OutboxPoll. `text` is then the log line. */
  poll_json: string | null
  created_at: number
  sent_at: number | null
}

/** A queued media send: the bytes wait in data/media/<path> until WhatsApp takes them. */
export type OutboxMedia = { kind: 'image' | 'document'; mime: string; file_name: string; size: number; path: string; tm8_file_id: string | null }

/** A queued WhatsApp poll: selectableCount 1 = single choice, 0 = any number. */
export type OutboxPoll = { name: string; values: string[]; selectableCount: number }

/** A tm8 form put into a group (POST /form). questions_json holds FormQuestion[] (forms.ts). */
export type FormDeliveryRow = {
  id: number
  form_id: string
  channel_id: string
  requested_by: string
  idempotency_key: string | null
  title: string
  questions_json: string
  allow_amend: number
  status: 'active' | 'closed'
  created_at: number
  checked_at: number | null
  closed_at: number | null
  /** Language of the bridge's own text around the questions (intro, hints, errors). */
  lang: Lang
  /** The case task it was sent for (POST /form {case}), if any. */
  case_id: string | null
}

export type Lang = 'en' | 'ar'

/**
 * A case (POST /case): one WhatsApp ask that a team of sessions works on. Every message sent with {case} goes to the
 * ask's thread, in the case's language.
 */
export type CaseRow = {
  task_id: string
  channel_id: string
  ask_wa_msg_id: string
  lang: Lang
  opened_by: string
  created_at: number
  last_ping_at: number | null
  pings: number
  pack_doc_id: string | null
  pack_wa_msg_id: string | null
  delivered_at: number | null
}

/** One message of a delivery: the intro, a poll or a numbered text question. wa_msg_id is set once it is sent. */
export type FormMessageRow = {
  outbox_id: number
  wa_msg_id: string | null
  delivery_id: number
  question_key: string | null
  kind: 'intro' | 'poll' | 'text'
}

/** One WhatsApp member's answers to one delivery; response_id is their current revision in tm8. */
export type FormRespondentRow = {
  id: number
  delivery_id: number
  person: string
  /** JSON array: every JID (PN and LID) this person was seen with. */
  jids: string
  name: string | null
  answers_json: string
  /** When the answers are due to be submitted (null: nothing to send). */
  due_at: number | null
  response_id: string | null
  submitted_json: string | null
  submissions: number
  attempts: number
  error: string | null
  updated_at: number
}

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
  /** granted: not routed, but the main chat handed the session this thread (it may /say there). */
  status: 'pending' | 'posted' | 'replied' | 'warned' | 'failed' | 'granted'
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
  CREATE TABLE IF NOT EXISTS form_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    idempotency_key TEXT,
    title TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    allow_amend INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
    created_at INTEGER NOT NULL,
    checked_at INTEGER,
    closed_at INTEGER,
    UNIQUE (requested_by, idempotency_key)
  );
  CREATE TABLE IF NOT EXISTS form_messages (
    outbox_id INTEGER PRIMARY KEY,
    wa_msg_id TEXT UNIQUE,
    delivery_id INTEGER NOT NULL,
    question_key TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('intro', 'poll', 'text'))
  );
  CREATE TABLE IF NOT EXISTS form_respondents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id INTEGER NOT NULL,
    person TEXT NOT NULL,
    jids TEXT NOT NULL,
    name TEXT,
    answers_json TEXT NOT NULL DEFAULT '{}',
    due_at INTEGER,
    response_id TEXT,
    submitted_json TEXT,
    submissions INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE (delivery_id, person)
  );
  CREATE TABLE IF NOT EXISTS cases (
    task_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    ask_wa_msg_id TEXT NOT NULL,
    lang TEXT NOT NULL CHECK (lang IN ('en', 'ar')),
    opened_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_ping_at INTEGER,
    pings INTEGER NOT NULL DEFAULT 0,
    pack_doc_id TEXT,
    pack_wa_msg_id TEXT,
    delivered_at INTEGER
  );
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
    if (!outCols.has('poll_json')) this.db.exec(`ALTER TABLE outbox_v1 ADD COLUMN poll_json TEXT`)
    const fdCols = new Set((this.db.prepare(`PRAGMA table_info(form_deliveries)`).all() as { name: string }[]).map((c) => c.name))
    if (!fdCols.has('lang')) this.db.exec(`ALTER TABLE form_deliveries ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'`)
    if (!fdCols.has('case_id')) this.db.exec(`ALTER TABLE form_deliveries ADD COLUMN case_id TEXT`)
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
  /** A session that runs again after it ended: live, and briefed anew (with a new token). */
  reviveName(name: string) {
    this.db.prepare(`UPDATE names SET status = 'live', ended_at = NULL, briefed_at = NULL WHERE name = ?`).run(name)
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
  insertOutbox(r: { idempotency_key: string | null; name: string; channel_id: string; text: string; reply_to: string | null; kind?: OutboxRow['kind']; media?: OutboxMedia; poll?: OutboxPoll }): number {
    const { media, poll, ...rest } = r
    return Number(
      this.db
        .prepare(
          `INSERT INTO outbox_v1 (idempotency_key, name, channel_id, text, reply_to, status, kind, media_json, poll_json, created_at)
           VALUES (@idempotency_key, @name, @channel_id, @text, @reply_to, 'queued', @kind, @media_json, @poll_json, @created_at)`,
        )
        .run({
          kind: media ? 'media' : poll ? 'poll' : 'text', ...rest, media_json: media ? JSON.stringify(media) : null,
          poll_json: poll ? JSON.stringify(poll) : null, created_at: this.now(),
        }).lastInsertRowid,
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
  /** Routes to `target` posted since `since` that nobody answered yet. */
  openRoutes(target: string, since: number): RouteRow[] {
    return this.db
      .prepare(`SELECT * FROM routes WHERE target_name = ? AND status IN ('posted', 'warned') AND posted_at >= ? ORDER BY id`)
      .all(target, since) as RouteRow[]
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

  // ---- forms ----
  insertFormDelivery(
    d: Pick<FormDeliveryRow, 'form_id' | 'channel_id' | 'requested_by' | 'idempotency_key' | 'title' | 'questions_json' | 'allow_amend'> &
      Partial<Pick<FormDeliveryRow, 'lang' | 'case_id'>>,
  ): number {
    return Number(
      this.db
        .prepare(
          `INSERT INTO form_deliveries (form_id, channel_id, requested_by, idempotency_key, title, questions_json, allow_amend, status, created_at, lang, case_id)
           VALUES (@form_id, @channel_id, @requested_by, @idempotency_key, @title, @questions_json, @allow_amend, 'active', @created_at, @lang, @case_id)`,
        )
        .run({ lang: 'en', case_id: null, ...d, created_at: this.now() }).lastInsertRowid,
    )
  }
  formDeliveriesOfCase(caseId: string): FormDeliveryRow[] {
    return this.db.prepare(`SELECT * FROM form_deliveries WHERE case_id = ? ORDER BY id`).all(caseId) as FormDeliveryRow[]
  }

  // ---- cases ----
  insertCase(c: Pick<CaseRow, 'task_id' | 'channel_id' | 'ask_wa_msg_id' | 'lang' | 'opened_by'>) {
    this.db
      .prepare(`INSERT INTO cases (task_id, channel_id, ask_wa_msg_id, lang, opened_by, created_at) VALUES (@task_id, @channel_id, @ask_wa_msg_id, @lang, @opened_by, @created_at)`)
      .run({ ...c, created_at: this.now() })
  }
  getCase(taskId: string): CaseRow | undefined {
    return this.db.prepare(`SELECT * FROM cases WHERE task_id = ?`).get(taskId) as CaseRow | undefined
  }
  setCaseLang(taskId: string, lang: Lang) {
    this.db.prepare(`UPDATE cases SET lang = ? WHERE task_id = ?`).run(lang, taskId)
  }
  recordCasePing(taskId: string) {
    this.db.prepare(`UPDATE cases SET last_ping_at = ?, pings = pings + 1 WHERE task_id = ?`).run(this.now(), taskId)
  }
  recordCasePack(taskId: string, docId: string, waMsgId: string | null) {
    this.db.prepare(`UPDATE cases SET pack_doc_id = ?, pack_wa_msg_id = ?, delivered_at = ? WHERE task_id = ?`).run(docId, waMsgId, this.now(), taskId)
  }

  formDelivery(id: number): FormDeliveryRow | undefined {
    return this.db.prepare(`SELECT * FROM form_deliveries WHERE id = ?`).get(id) as FormDeliveryRow | undefined
  }
  formDeliveryByKey(requestedBy: string, key: string): FormDeliveryRow | undefined {
    return this.db.prepare(`SELECT * FROM form_deliveries WHERE requested_by = ? AND idempotency_key = ?`).get(requestedBy, key) as FormDeliveryRow | undefined
  }
  activeFormDelivery(formId: string, channelId: string): FormDeliveryRow | undefined {
    return this.db.prepare(`SELECT * FROM form_deliveries WHERE form_id = ? AND channel_id = ? AND status = 'active'`).get(formId, channelId) as
      | FormDeliveryRow
      | undefined
  }
  /** A channel's deliveries, newest first (active only, or all). */
  formDeliveries(channelId: string, o: { activeOnly?: boolean; limit?: number } = {}): FormDeliveryRow[] {
    return this.db
      .prepare(`SELECT * FROM form_deliveries WHERE channel_id = ?${o.activeOnly ? ` AND status = 'active'` : ''} ORDER BY id DESC LIMIT ?`)
      .all(channelId, o.limit ?? 50) as FormDeliveryRow[]
  }
  allActiveFormDeliveries(): FormDeliveryRow[] {
    return this.db.prepare(`SELECT * FROM form_deliveries WHERE status = 'active' ORDER BY id`).all() as FormDeliveryRow[]
  }
  setFormDeliveryChecked(id: number) {
    this.db.prepare(`UPDATE form_deliveries SET checked_at = ? WHERE id = ?`).run(this.now(), id)
  }
  closeFormDelivery(id: number) {
    this.db.prepare(`UPDATE form_deliveries SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'active'`).run(this.now(), id)
  }
  insertFormMessage(m: Omit<FormMessageRow, 'wa_msg_id'>) {
    this.db.prepare(`INSERT INTO form_messages (outbox_id, delivery_id, question_key, kind) VALUES (@outbox_id, @delivery_id, @question_key, @kind)`).run(m)
  }
  /** Called for every sent outbox row; a no-op unless the row is a form message. */
  formMessageSent(outboxId: number, waId: string) {
    this.db.prepare(`UPDATE form_messages SET wa_msg_id = ? WHERE outbox_id = ?`).run(waId, outboxId)
  }
  formMessage(waId: string): FormMessageRow | undefined {
    return this.db.prepare(`SELECT * FROM form_messages WHERE wa_msg_id = ?`).get(waId) as FormMessageRow | undefined
  }
  formMessagesOf(deliveryId: number): FormMessageRow[] {
    return this.db.prepare(`SELECT * FROM form_messages WHERE delivery_id = ? ORDER BY outbox_id`).all(deliveryId) as FormMessageRow[]
  }
  formRespondents(deliveryId: number): FormRespondentRow[] {
    return this.db.prepare(`SELECT * FROM form_respondents WHERE delivery_id = ? ORDER BY id`).all(deliveryId) as FormRespondentRow[]
  }
  formRespondent(id: number): FormRespondentRow | undefined {
    return this.db.prepare(`SELECT * FROM form_respondents WHERE id = ?`).get(id) as FormRespondentRow | undefined
  }
  insertFormRespondent(r: Pick<FormRespondentRow, 'delivery_id' | 'person' | 'jids' | 'name'>): number {
    return Number(
      this.db
        .prepare(`INSERT INTO form_respondents (delivery_id, person, jids, name, updated_at) VALUES (@delivery_id, @person, @jids, @name, @updated_at)`)
        .run({ ...r, updated_at: this.now() }).lastInsertRowid,
    )
  }
  updateFormRespondent(
    id: number,
    p: Partial<Pick<FormRespondentRow, 'jids' | 'name' | 'answers_json' | 'due_at' | 'response_id' | 'submitted_json' | 'submissions' | 'attempts' | 'error'>>,
  ) {
    const cols = Object.keys(p)
    if (cols.length === 0) return
    this.db.prepare(`UPDATE form_respondents SET ${cols.map((c) => `${c} = @${c}`).join(', ')}, updated_at = @t WHERE id = @id`).run({ ...p, t: this.now(), id })
  }
  /** Respondents whose answers are due, in active deliveries. */
  dueFormRespondents(now: number): FormRespondentRow[] {
    return this.db
      .prepare(
        `SELECT r.* FROM form_respondents r JOIN form_deliveries d ON d.id = r.delivery_id
         WHERE r.due_at IS NOT NULL AND r.due_at <= ? AND d.status = 'active' ORDER BY r.due_at`,
      )
      .all(now) as FormRespondentRow[]
  }
}
