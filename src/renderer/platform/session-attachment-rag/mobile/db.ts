import {
  CapacitorSQLite,
  SQLiteConnection,
  type capSQLiteSet,
  type SQLiteDBConnection,
} from '@capacitor-community/sqlite'
import { planOrphanCleanup } from '@shared/session-attachment-rag/ownership'
import type {
  CreateSessionAttachmentParams,
  SessionAttachmentChunkRecord,
  SessionAttachmentParent,
  SessionAttachmentParentRecord,
  SessionAttachmentRecord,
  SessionAttachmentStatus,
  SessionAttachmentIndexingStage,
  SessionAttachmentRagDebugSnapshot,
} from './types'

const DB_NAME = 'chatbox-session-rag'

/**
 * Machine-generated bookkeeping lines that the story-KB builder emits next to real cards
 * (`entity_candidate_id:*`, `record_type:*`, `certainty:*`, ...). They score highly on entity
 * matches but carry no canon content, so retrieval excludes them unless asked otherwise.
 */
const METADATA_FRAGMENT_PATTERNS = [
  '%entity_candidate%',
  '%record_type:%',
  '%certainty:%',
  '%source_refs:%',
  '%promoted_by:%',
  '%ord_type:%',
]

function mapRowToAttachmentRecord(row: Record<string, unknown>): SessionAttachmentRecord {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    messageId: String(row.message_id),
    attachmentStorageKey: String(row.attachment_storage_key),
    filename: String(row.filename),
    mimeType: String(row.mime_type ?? ''),
    fileSize: Number(row.file_size ?? 0),
    tokenEstimate: Number(row.token_estimate ?? 0),
    parserType: row.parser_type ? String(row.parser_type) : undefined,
    status: String(row.status) as SessionAttachmentStatus,
    indexingStage: row.indexing_stage ? (String(row.indexing_stage) as SessionAttachmentIndexingStage) : undefined,
    totalChunks: Number(row.total_chunks ?? 0),
    embeddedChunks: Number(row.embedded_chunks ?? 0),
    chunkCount: Number(row.total_chunks ?? 0),
    embeddingModel: row.embedding_model ? String(row.embedding_model) : undefined,
    embeddingDimension:
      row.embedding_dimension !== null && row.embedding_dimension !== undefined
        ? Number(row.embedding_dimension)
        : undefined,
    error: row.error ? String(row.error) : undefined,
    createdAt: row.created_at ? String(row.created_at) : undefined,
    processingStartedAt: row.processing_started_at ? String(row.processing_started_at) : undefined,
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
  }
}

function mapRowToParentRecord(row: Record<string, unknown>): SessionAttachmentParentRecord {
  return {
    id: Number(row.id),
    attachmentId: Number(row.attachment_id),
    parentOrder: Number(row.parent_order),
    sectionPath: row.section_path ? String(row.section_path) : undefined,
    docType: row.doc_type ? String(row.doc_type) : undefined,
    pageStart: row.page_start !== null && row.page_start !== undefined ? Number(row.page_start) : undefined,
    pageEnd: row.page_end !== null && row.page_end !== undefined ? Number(row.page_end) : undefined,
    text: String(row.text),
    tokenEstimate: Number(row.token_estimate ?? 0),
    charCount: Number(row.char_count ?? 0),
    createdAt: row.created_at ? String(row.created_at) : undefined,
  }
}

function parseJsonArray(val: unknown): string[] | undefined {
  if (!val) return undefined
  if (Array.isArray(val)) return val.map(String)
  try {
    const parsed = JSON.parse(String(val))
    return Array.isArray(parsed) ? parsed.map(String) : undefined
  } catch {
    return [String(val)]
  }
}

function parseJsonObject(val: unknown): Record<string, unknown> | undefined {
  if (!val) return undefined
  if (typeof val === 'object' && !Array.isArray(val)) return val as Record<string, unknown>
  try {
    const parsed = JSON.parse(String(val))
    return typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function mapRowToChunkRecord(row: Record<string, unknown>): SessionAttachmentChunkRecord {
  return {
    id: Number(row.id),
    attachmentId: Number(row.attachment_id),
    parentId: Number(row.parent_id),
    chunkOrder: Number(row.chunk_order),
    sectionPath: row.section_path ? String(row.section_path) : undefined,
    pageStart: row.page_start !== null && row.page_start !== undefined ? Number(row.page_start) : undefined,
    pageEnd: row.page_end !== null && row.page_end !== undefined ? Number(row.page_end) : undefined,
    rawText: String(row.raw_text),
    embeddedText: String(row.embedded_text),
    tokenEstimate: Number(row.token_estimate ?? 0),
    entities: parseJsonArray(row.entities),
    keywords: parseJsonArray(row.keywords),
    chapterOrder: row.chapter_order !== null && row.chapter_order !== undefined ? Number(row.chapter_order) : undefined,
    storyTime: row.story_time ? String(row.story_time) : undefined,
    stateKind: row.state_kind ? String(row.state_kind) : undefined,
    validFrom: row.valid_from !== null && row.valid_from !== undefined ? Number(row.valid_from) : undefined,
    validTo: row.valid_to !== null && row.valid_to !== undefined ? Number(row.valid_to) : undefined,
    priorityRank: row.priority_rank !== null && row.priority_rank !== undefined ? Number(row.priority_rank) : 2,
    kind: row.kind ? String(row.kind) : undefined,
    metadata: parseJsonObject(row.metadata),
    createdAt: row.created_at ? String(row.created_at) : undefined,
  }
}

function extractIndexableTerms(chunk: {
  sectionPath?: string
  entities?: string[]
  keywords?: string[]
}): string[] {
  const terms = new Set<string>()
  const add = (raw?: string) => {
    if (!raw) return
    const clean = raw.trim().toLowerCase()
    if (clean.length >= 2 && clean.length <= 24) {
      terms.add(clean)
    }
  }
  if (chunk.entities) {
    for (const e of chunk.entities) add(e)
  }
  if (chunk.keywords) {
    for (const k of chunk.keywords) add(k)
  }
  if (chunk.sectionPath) {
    const colonIdx = chunk.sectionPath.indexOf(':')
    if (colonIdx >= 0) {
      add(chunk.sectionPath.slice(colonIdx + 1))
    }
  }
  return Array.from(terms)
}

export class MobileRagDatabase {
  private sqlite: SQLiteConnection
  private database!: SQLiteDBConnection
  private initPromise: Promise<void> | null = null
  /** True when the FTS5 trigram index is available (SQLite >= 3.34 with FTS5 compiled in). */
  private ftsEnabled = false
  /** True when the inverted term table has indexed terms for O(log N) 2-char and non-FTS5 recall. */
  private hasTermIndex = false

  constructor(sqliteConnection?: SQLiteConnection) {
    this.sqlite = sqliteConnection ?? new SQLiteConnection(CapacitorSQLite)
  }

  public initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise
    }
    this.initPromise = this.openDatabase()
    return this.initPromise
  }

  public getDatabase(): SQLiteDBConnection {
    return this.database
  }

  private async openDatabase(): Promise<void> {
    // closeConnection is async: without awaiting it the rejection ("No available connection
    // for database ...") escapes the try/catch and surfaces as an unhandled rejection.
    await Promise.resolve(this.sqlite.closeConnection(DB_NAME, false)).catch(() => {
      // ignore - connection may not exist yet
    })

    this.database = await this.sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false)
    await this.database.open()

    // Enable WAL & relaxed fsync so bulk imports (90+ batches) do not block on synchronous disk flushes.
    try {
      await this.database.execute('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY;')
    } catch {
      // Some web/mock drivers ignore or reject WAL PRAGMAs cleanly.
    }

    await this.database.execute(`
      CREATE TABLE IF NOT EXISTS session_attachment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        attachment_storage_key TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        token_estimate INTEGER DEFAULT 0,
        parser_type TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        indexing_stage TEXT DEFAULT NULL,
        total_chunks INTEGER DEFAULT 0,
        embedded_chunks INTEGER DEFAULT 0,
        embedding_model TEXT DEFAULT NULL,
        embedding_dimension INTEGER DEFAULT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        processing_started_at INTEGER,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS session_attachment_parent (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attachment_id INTEGER NOT NULL,
        parent_order INTEGER NOT NULL,
        section_path TEXT,
        doc_type TEXT,
        page_start INTEGER,
        page_end INTEGER,
        text TEXT NOT NULL,
        token_estimate INTEGER DEFAULT 0,
        char_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_attachment_chunk (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attachment_id INTEGER NOT NULL,
        parent_id INTEGER NOT NULL,
        chunk_order INTEGER NOT NULL,
        section_path TEXT,
        page_start INTEGER,
        page_end INTEGER,
        raw_text TEXT NOT NULL,
        embedded_text TEXT NOT NULL,
        token_estimate INTEGER DEFAULT 0,
        entities TEXT,
        keywords TEXT,
        chapter_order INTEGER,
        story_time TEXT,
        state_kind TEXT,
        valid_from INTEGER,
        valid_to INTEGER,
        priority_rank INTEGER DEFAULT 2,
        kind TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_attachment_vector (
        chunk_id INTEGER PRIMARY KEY,
        attachment_id INTEGER NOT NULL,
        vector TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_attachment_term (
        attachment_id INTEGER NOT NULL,
        term TEXT NOT NULL,
        chunk_id INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sa_session_id ON session_attachment(session_id);
      CREATE INDEX IF NOT EXISTS idx_sa_message_id ON session_attachment(message_id);
      CREATE INDEX IF NOT EXISTS idx_sa_status ON session_attachment(status);
      CREATE INDEX IF NOT EXISTS idx_sap_attachment_id ON session_attachment_parent(attachment_id);
      CREATE INDEX IF NOT EXISTS idx_sac_attachment_id ON session_attachment_chunk(attachment_id);
      CREATE INDEX IF NOT EXISTS idx_sac_parent_id ON session_attachment_chunk(parent_id);
      CREATE INDEX IF NOT EXISTS idx_sac_chapter ON session_attachment_chunk(attachment_id, chapter_order);
      CREATE INDEX IF NOT EXISTS idx_sac_priority ON session_attachment_chunk(attachment_id, priority_rank);
      CREATE INDEX IF NOT EXISTS idx_sac_state_window ON session_attachment_chunk(attachment_id, state_kind, valid_from, valid_to);
      CREATE INDEX IF NOT EXISTS idx_sav_attachment_id ON session_attachment_vector(attachment_id);
      CREATE INDEX IF NOT EXISTS idx_sat_att_term ON session_attachment_term(attachment_id, term);
      CREATE INDEX IF NOT EXISTS idx_sat_chunk_id ON session_attachment_term(chunk_id);
    `)

    const colsToAdd: Array<{ name: string; type: string }> = [
      { name: 'entities', type: 'TEXT' },
      { name: 'keywords', type: 'TEXT' },
      { name: 'chapter_order', type: 'INTEGER' },
      { name: 'story_time', type: 'TEXT' },
      { name: 'state_kind', type: 'TEXT' },
      { name: 'valid_from', type: 'INTEGER' },
      { name: 'valid_to', type: 'INTEGER' },
      { name: 'priority_rank', type: 'INTEGER DEFAULT 2' },
      { name: 'kind', type: 'TEXT' },
      { name: 'metadata', type: 'TEXT' },
    ]
    try {
      const tableInfo = await this.database.query('PRAGMA table_info(session_attachment_chunk)')
      const rows = tableInfo.values ?? []
      if (rows.length > 0) {
        const existingCols = new Set(rows.map((r) => String(r.name)))
        for (const col of colsToAdd) {
          if (!existingCols.has(col.name)) {
            await this.database.execute(`ALTER TABLE session_attachment_chunk ADD COLUMN ${col.name} ${col.type};`)
          }
        }
      }
    } catch {
      // Ignore schema inspection errors on mocked drivers
    }

    await this.initializeFtsIndex()
    await this.initializeTermIndex()
  }

  private async initializeTermIndex(): Promise<void> {
    try {
      const existingTerm = await this.database.query('SELECT 1 FROM session_attachment_term LIMIT 1')
      if ((existingTerm.values ?? []).length > 0) {
        this.hasTermIndex = true
        return
      }
      const existingChunks = await this.database.query(
        "SELECT 1 FROM session_attachment_chunk WHERE (entities IS NOT NULL AND entities != '') OR (keywords IS NOT NULL AND keywords != '') LIMIT 1"
      )
      if ((existingChunks.values ?? []).length > 0) {
        await this.backfillTermIndex()
      }
    } catch {
      this.hasTermIndex = false
    }
  }

  private async backfillTermIndex(): Promise<void> {
    const PAGE = 500
    let lastId = 0
    let insertedAny = false
    while (true) {
      const res = await this.database.query(
        'SELECT id, attachment_id, section_path, entities, keywords FROM session_attachment_chunk WHERE id > ? ORDER BY id ASC LIMIT ?',
        [lastId, PAGE]
      )
      const rows = res.values ?? []
      if (rows.length === 0) break
      lastId = Number(rows[rows.length - 1].id)
      const entries: Array<{ attachmentId: number; term: string; chunkId: number }> = []
      for (const row of rows) {
        const chunkId = Number(row.id)
        const attachmentId = Number(row.attachment_id)
        const terms = extractIndexableTerms({
          sectionPath: row.section_path ? String(row.section_path) : undefined,
          entities: parseJsonArray(row.entities),
          keywords: parseJsonArray(row.keywords),
        })
        for (const term of terms) {
          entries.push({ attachmentId, term, chunkId })
        }
      }
      if (entries.length > 0) {
        await this.insertTermEntries(entries)
        insertedAny = true
      }
      if (rows.length < PAGE) break
    }
    if (insertedAny) {
      this.hasTermIndex = true
    }
  }

  private async insertTermEntries(
    entries: Array<{ attachmentId: number; term: string; chunkId: number }>
  ): Promise<void> {
    if (entries.length === 0) return
    // Multi-row INSERT keeps variables <= 300 per statement (well below SQLite's 999 limit)
    // while slashing Capacitor/sql.js bridge round-trips by 100x.
    const ROWS_PER_STMT = 100
    const STMTS_PER_SET = 50
    const statements: capSQLiteSet[] = []
    for (let i = 0; i < entries.length; i += ROWS_PER_STMT) {
      const slice = entries.slice(i, i + ROWS_PER_STMT)
      const placeholders = slice.map(() => '(?, ?, ?)').join(',')
      const values: unknown[] = []
      for (const e of slice) {
        values.push(e.attachmentId, e.term, e.chunkId)
      }
      statements.push({
        statement: `INSERT INTO session_attachment_term (attachment_id, term, chunk_id) VALUES ${placeholders}`,
        values,
      })
      if (statements.length >= STMTS_PER_SET) {
        await this.database.executeSet(statements.splice(0, statements.length))
      }
    }
    if (statements.length > 0) {
      await this.database.executeSet(statements)
    }
    this.hasTermIndex = true
  }

  /**
   * Build the FTS5 trigram index used for Chinese substring recall.
   *
   * A plain `LIKE '%term%'` scan over tens of thousands of chunks costs hundreds of
   * milliseconds per query on a phone. FTS5 with the trigram tokenizer supports arbitrary
   * substring matching (which is what CJK needs, since unicode61 would treat a whole
   * sentence as one token) and lets SQLite walk an index instead.
   *
   * The index is external-content, so it stores no duplicate text: it is rebuilt from
   * session_attachment_chunk. Devices without FTS5/trigram simply keep the LIKE path.
   */
  private async initializeFtsIndex(): Promise<void> {
    try {
      const existing = await this.database.query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_attachment_chunk_fts'"
      )
      const alreadyCreated = (existing.values ?? []).length > 0
      if (!alreadyCreated) {
        await this.database.execute(`
          CREATE VIRTUAL TABLE session_attachment_chunk_fts USING fts5(
            raw_text, section_path, entities, keywords,
            content='session_attachment_chunk',
            content_rowid='id',
            tokenize='trigram'
          );
        `)
      }
      this.ftsEnabled = true
      if (!alreadyCreated) {
        await this.rebuildFtsIndex()
      }
    } catch (error) {
      this.ftsEnabled = false
      console.warn('FTS5 trigram index unavailable, falling back to LIKE scan', error)
    }
  }

  /** Re-index the whole chunk table. Cheap enough to run once per attachment import. */
  private async rebuildFtsIndex(): Promise<void> {
    if (!this.ftsEnabled) return
    await this.database.execute(
      "INSERT INTO session_attachment_chunk_fts(session_attachment_chunk_fts) VALUES('rebuild')"
    )
  }

  public async cleanupInterruptedIndexingAttachments(): Promise<number> {
    try {
      const res = await this.database.query("SELECT id FROM session_attachment WHERE status = 'indexing'")
      const rows = res.values ?? []
      if (rows.length > 0) {
        await this.database.run(
          "UPDATE session_attachment SET status = 'failed', error = 'interrupted', processing_started_at = NULL WHERE status = 'indexing'"
        )
      }
      return rows.length
    } catch {
      return 0
    }
  }

  public async createAttachment(params: CreateSessionAttachmentParams): Promise<number> {
    await this.initialize()
    const now = Date.now()
    const result = await this.database.run(
      `INSERT INTO session_attachment (
        session_id, message_id, attachment_storage_key, filename, mime_type,
        file_size, token_estimate, parser_type, status, indexing_stage, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'queued', ?)`,
      [
        params.sessionId,
        params.messageId,
        params.attachmentStorageKey,
        params.filename,
        params.mimeType,
        params.fileSize,
        params.tokenEstimate,
        params.parserType ?? null,
        now,
      ]
    )

    const lastId = result.changes?.lastId
    if (lastId === undefined || lastId === null) {
      const queryResult = await this.database.query('SELECT last_insert_rowid() as id')
      return Number(queryResult.values?.[0]?.id)
    }
    return Number(lastId)
  }

  public async getAttachment(id: number): Promise<SessionAttachmentRecord | null> {
    await this.initialize()
    const result = await this.database.query('SELECT * FROM session_attachment WHERE id = ?', [id])
    const row = result.values?.[0]
    return row ? mapRowToAttachmentRecord(row) : null
  }

  public async getAttachments(ids: number[]): Promise<SessionAttachmentRecord[]> {
    if (ids.length === 0) return []
    await this.initialize()
    const placeholders = ids.map(() => '?').join(',')
    const result = await this.database.query(
      `SELECT * FROM session_attachment WHERE id IN (${placeholders})`,
      ids
    )
    return (result.values ?? []).map(mapRowToAttachmentRecord)
  }

  public async listPendingAttachments(limit = 5): Promise<SessionAttachmentRecord[]> {
    await this.initialize()
    const result = await this.database.query(
      'SELECT * FROM session_attachment WHERE status = ? ORDER BY id ASC LIMIT ?',
      ['pending', limit]
    )
    return (result.values ?? []).map(mapRowToAttachmentRecord)
  }

  public async updateAttachment(id: number, updates: Partial<SessionAttachmentRecord>): Promise<void> {
    await this.initialize()
    const setClauses: string[] = []
    const values: unknown[] = []

    if (updates.status !== undefined) {
      setClauses.push('status = ?')
      values.push(updates.status)
    }
    if (updates.indexingStage !== undefined) {
      setClauses.push('indexing_stage = ?')
      values.push(updates.indexingStage)
    }
    if (updates.totalChunks !== undefined) {
      setClauses.push('total_chunks = ?')
      values.push(updates.totalChunks)
    }
    if (updates.embeddedChunks !== undefined) {
      setClauses.push('embedded_chunks = ?')
      values.push(updates.embeddedChunks)
    }
    if (updates.embeddingModel !== undefined) {
      setClauses.push('embedding_model = ?')
      values.push(updates.embeddingModel)
    }
    if (updates.embeddingDimension !== undefined) {
      setClauses.push('embedding_dimension = ?')
      values.push(updates.embeddingDimension)
    }
    if (updates.error !== undefined) {
      setClauses.push('error = ?')
      values.push(updates.error)
    }
    if (updates.processingStartedAt !== undefined) {
      setClauses.push('processing_started_at = ?')
      values.push(updates.processingStartedAt)
    }
    if (updates.completedAt !== undefined) {
      setClauses.push('completed_at = ?')
      values.push(updates.completedAt)
    }

    if (setClauses.length === 0) return
    values.push(id)
    await this.database.run(
      `UPDATE session_attachment SET ${setClauses.join(', ')} WHERE id = ?`,
      values
    )
  }

  public async updateAttachmentProgress(
    id: number,
    progress: {
      indexingStage?: SessionAttachmentIndexingStage
      totalChunks?: number
      embeddedChunks?: number
      embeddingModel?: string
      embeddingDimension?: number
    }
  ): Promise<void> {
    await this.updateAttachment(id, progress)
  }

  public async markAttachmentStatus(
    id: number,
    status: SessionAttachmentStatus,
    error?: string
  ): Promise<void> {
    const now = Date.now()
    if (status === 'indexing') {
      await this.updateAttachment(id, {
        status,
        indexingStage: 'chunking',
        processingStartedAt: String(now),
        error: undefined,
      })
    } else if (status === 'ready') {
      await this.updateAttachment(id, {
        status,
        indexingStage: 'ready',
        completedAt: String(now),
        error: undefined,
      })
    } else if (status === 'failed') {
      await this.updateAttachment(id, {
        status,
        error: error || 'Indexing failed',
      })
    } else {
      await this.updateAttachment(id, { status, error })
    }
  }

  public async rebindAttachment(attachmentId: number, sessionId: string, messageId: string): Promise<void> {
    await this.initialize()
    await this.database.run(
      'UPDATE session_attachment SET session_id = ?, message_id = ? WHERE id = ?',
      [sessionId, messageId, attachmentId]
    )
  }

  public async deleteAttachment(attachmentId: number, options?: { skipFtsRebuild?: boolean }): Promise<void> {
    await this.initialize()
    const set: capSQLiteSet[] = [
      { statement: 'DELETE FROM session_attachment_term WHERE attachment_id = ?', values: [attachmentId] },
      { statement: 'DELETE FROM session_attachment_vector WHERE attachment_id = ?', values: [attachmentId] },
      { statement: 'DELETE FROM session_attachment_chunk WHERE attachment_id = ?', values: [attachmentId] },
      { statement: 'DELETE FROM session_attachment_parent WHERE attachment_id = ?', values: [attachmentId] },
      { statement: 'DELETE FROM session_attachment WHERE id = ?', values: [attachmentId] },
    ]
    await this.database.executeSet(set)
    if (!options?.skipFtsRebuild) {
      await this.rebuildFtsIndex()
    }
  }

  public async deleteMessageAttachments(messageId: string): Promise<number[]> {
    await this.initialize()
    const rows = await this.database.query('SELECT id FROM session_attachment WHERE message_id = ?', [messageId])
    const ids = (rows.values ?? []).map((r) => Number(r.id))
    for (const id of ids) {
      await this.deleteAttachment(id, { skipFtsRebuild: true })
    }
    if (ids.length > 0) {
      await this.rebuildFtsIndex()
    }
    return ids
  }

  public async deleteSessionAttachments(sessionId: string): Promise<number[]> {
    await this.initialize()
    const rows = await this.database.query('SELECT id FROM session_attachment WHERE session_id = ?', [sessionId])
    const ids = (rows.values ?? []).map((r) => Number(r.id))
    for (const id of ids) {
      await this.deleteAttachment(id, { skipFtsRebuild: true })
    }
    if (ids.length > 0) {
      await this.rebuildFtsIndex()
    }
    return ids
  }

  public async replaceParentsAndChunks(
    attachmentId: number,
    parents: Array<{
      parentOrder: number
      sectionPath?: string
      docType?: string
      pageStart?: number
      pageEnd?: number
      text: string
      tokenEstimate: number
      charCount: number
    }>,
    children: Array<{
      parentOrder: number
      chunkOrder: number
      sectionPath?: string
      pageStart?: number
      pageEnd?: number
      rawText: string
      embeddedText: string
      tokenEstimate: number
      entities?: string[]
      keywords?: string[]
      chapterOrder?: number
      storyTime?: string
      stateKind?: string
      validFrom?: number
      validTo?: number
      priorityRank?: number
      kind?: string
      metadata?: Record<string, unknown>
    }>
  ): Promise<number[]> {
    await this.initialize()
    const now = Date.now()

    // Clean previous parent/chunk/vector/term records for this attachment
    await this.database.executeSet([
      { statement: 'DELETE FROM session_attachment_term WHERE attachment_id = ?', values: [attachmentId] },
      { statement: 'DELETE FROM session_attachment_vector WHERE attachment_id = ?', values: [attachmentId] },
      { statement: 'DELETE FROM session_attachment_chunk WHERE attachment_id = ?', values: [attachmentId] },
      { statement: 'DELETE FROM session_attachment_parent WHERE attachment_id = ?', values: [attachmentId] },
    ])

    const useBatchExecuteSet = parents.length > 50 || children.length > 100
    const parentIdByOrder = new Map<number, number>()

    if (useBatchExecuteSet) {
      const BATCH = 400
      for (let i = 0; i < parents.length; i += BATCH) {
        const slice = parents.slice(i, i + BATCH)
        const set: capSQLiteSet[] = slice.map((p) => ({
          statement: `INSERT INTO session_attachment_parent (
            attachment_id, parent_order, section_path, doc_type,
            page_start, page_end, text, token_estimate, char_count, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          values: [
            attachmentId,
            p.parentOrder,
            p.sectionPath ?? null,
            p.docType ?? null,
            p.pageStart ?? null,
            p.pageEnd ?? null,
            p.text,
            p.tokenEstimate,
            p.charCount,
            now,
          ],
        }))
        await this.database.executeSet(set)
      }
      const parentRows = await this.database.query(
        'SELECT id, parent_order FROM session_attachment_parent WHERE attachment_id = ? ORDER BY parent_order ASC',
        [attachmentId]
      )
      for (const r of parentRows.values ?? []) {
        parentIdByOrder.set(Number(r.parent_order), Number(r.id))
      }

      for (let i = 0; i < children.length; i += BATCH) {
        const slice = children.slice(i, i + BATCH)
        const set: capSQLiteSet[] = slice.map((c) => {
          const parentId = parentIdByOrder.get(c.parentOrder) ?? 0
          const entitiesJson = c.entities?.length ? JSON.stringify(c.entities) : null
          const keywordsJson = c.keywords?.length ? JSON.stringify(c.keywords) : null
          const metadataJson = c.metadata ? JSON.stringify(c.metadata) : null
          return {
            statement: `INSERT INTO session_attachment_chunk (
              attachment_id, parent_id, chunk_order, section_path,
              page_start, page_end, raw_text, embedded_text, token_estimate,
              entities, keywords, chapter_order, story_time, state_kind, valid_from, valid_to, priority_rank, kind, metadata, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            values: [
              attachmentId,
              parentId,
              c.chunkOrder,
              c.sectionPath ?? null,
              c.pageStart ?? null,
              c.pageEnd ?? null,
              c.rawText,
              c.embeddedText,
              c.tokenEstimate,
              entitiesJson,
              keywordsJson,
              c.chapterOrder ?? null,
              c.storyTime ?? null,
              c.stateKind ?? null,
              c.validFrom ?? null,
              c.validTo ?? null,
              c.priorityRank ?? 2,
              c.kind ?? null,
              metadataJson,
              now,
            ],
          }
        })
        await this.database.executeSet(set)
      }
      const chunkRows = await this.database.query(
        'SELECT id FROM session_attachment_chunk WHERE attachment_id = ? ORDER BY chunk_order ASC',
        [attachmentId]
      )
      const chunkIds = (chunkRows.values ?? []).map((r) => Number(r.id))
      await this.insertTermsForChunks(attachmentId, children, chunkIds)
      await this.rebuildFtsIndex()
      return chunkIds
    }

    // Insert parents individually to get their generated IDs (small attachments & unit tests)
    for (const p of parents) {
      const res = await this.database.run(
        `INSERT INTO session_attachment_parent (
          attachment_id, parent_order, section_path, doc_type,
          page_start, page_end, text, token_estimate, char_count, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attachmentId,
          p.parentOrder,
          p.sectionPath ?? null,
          p.docType ?? null,
          p.pageStart ?? null,
          p.pageEnd ?? null,
          p.text,
          p.tokenEstimate,
          p.charCount,
          now,
        ]
      )
      const parentId = res.changes?.lastId ?? (await this.database.query('SELECT last_insert_rowid() as id')).values?.[0]?.id
      parentIdByOrder.set(p.parentOrder, Number(parentId))
    }

    // Insert children chunks with hybrid metadata
    const chunkIds: number[] = []
    for (const c of children) {
      const parentId = parentIdByOrder.get(c.parentOrder) ?? 0
      const entitiesJson = c.entities?.length ? JSON.stringify(c.entities) : null
      const keywordsJson = c.keywords?.length ? JSON.stringify(c.keywords) : null
      const metadataJson = c.metadata ? JSON.stringify(c.metadata) : null

      const res = await this.database.run(
        `INSERT INTO session_attachment_chunk (
          attachment_id, parent_id, chunk_order, section_path,
          page_start, page_end, raw_text, embedded_text, token_estimate,
          entities, keywords, chapter_order, story_time, state_kind, valid_from, valid_to, priority_rank, kind, metadata, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attachmentId,
          parentId,
          c.chunkOrder,
          c.sectionPath ?? null,
          c.pageStart ?? null,
          c.pageEnd ?? null,
          c.rawText,
          c.embeddedText,
          c.tokenEstimate,
          entitiesJson,
          keywordsJson,
          c.chapterOrder ?? null,
          c.storyTime ?? null,
          c.stateKind ?? null,
          c.validFrom ?? null,
          c.validTo ?? null,
          c.priorityRank ?? 2,
          c.kind ?? null,
          metadataJson,
          now,
        ]
      )
      const chunkId = res.changes?.lastId ?? (await this.database.query('SELECT last_insert_rowid() as id')).values?.[0]?.id
      chunkIds.push(Number(chunkId))
    }

    await this.insertTermsForChunks(attachmentId, children, chunkIds)
    await this.rebuildFtsIndex()
    return chunkIds
  }

  private async insertTermsForChunks(
    attachmentId: number,
    children: Array<{ sectionPath?: string; entities?: string[]; keywords?: string[] }>,
    chunkIds: number[]
  ): Promise<void> {
    if (chunkIds.length === 0 || chunkIds.length !== children.length) return
    const batch: Array<{ attachmentId: number; term: string; chunkId: number }> = []
    for (let i = 0; i < children.length; i++) {
      const chunkId = chunkIds[i]
      const terms = extractIndexableTerms(children[i])
      for (const term of terms) {
        batch.push({ attachmentId, term, chunkId })
      }
      if (batch.length >= 5000) {
        await this.insertTermEntries(batch.splice(0, batch.length))
      }
    }
    if (batch.length > 0) {
      await this.insertTermEntries(batch)
    }
  }

  public async searchKeywordChunks(
    attachmentIds: number[],
    options: {
      keywords?: string[]
      entities?: string[]
      maxChapter?: number
      limit?: number
      /** Keep chunks with no chapter ordinal when a spoiler ceiling is applied (default: drop them). */
      includeUnknownChapter?: boolean
      /** Keep machine-generated metadata stubs in the candidate set (default: drop them). */
      excludeMetadataFragments?: boolean
    }
  ): Promise<Array<SessionAttachmentChunkRecord & { filename: string; matchScore: number }>> {
    if (attachmentIds.length === 0) return []
    await this.initialize()

    const genericHighFreq = new Set([
      '方源', '古月方源', '蛊师', '蛊虫', '仙蛊', '杀招', '仙道杀招', '仙道',
      '仙尊', '魔尊', '尊者', '名号', '底蕴', '流派', '境界', '功法', '能力',
    ])
    const entitySet = new Set((options.entities ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))
    const rawTerms = [
      ...(options.entities ?? []),
      ...(options.keywords ?? []),
    ]
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0)

    if (rawTerms.length === 0) return []

    // Order specific entities/keywords ahead of ultra-frequent protagonist/generic terms,
    // and drop redundant 2-char substrings that are already covered by a 3+ char specific term
    const rawSpecific = [...new Set(rawTerms.filter((t) => !genericHighFreq.has(t)))]
    const longSpecific = rawSpecific.filter((t) => t.length >= 3)
    const filteredSpecific = rawSpecific.filter(
      (t) => t.length >= 3 || !longSpecific.some((longTerm) => longTerm !== t && longTerm.includes(t))
    )
    const fallbackGenericTerms = [...new Set(rawTerms.filter((t) => genericHighFreq.has(t)))]
    const uniqueTerms = [...filteredSpecific, ...fallbackGenericTerms].slice(0, 14)
    const hasSpecificTerm = filteredSpecific.length > 0

    const placeholders = attachmentIds.map(() => '?').join(',')

    const scoreExpressions = uniqueTerms.map((term) => {
      if (hasSpecificTerm && genericHighFreq.has(term)) {
        return `(CASE WHEN LOWER(c.section_path) LIKE ? OR LOWER(c.entities) LIKE ? THEN 2 WHEN LOWER(c.keywords) LIKE ? THEN 1 WHEN LOWER(c.raw_text) LIKE ? THEN 1 ELSE 0 END)`
      }
      if (entitySet.has(term) || term.length >= 4) {
        const w = 6
        return `(CASE WHEN LOWER(c.section_path) LIKE ? OR LOWER(c.entities) LIKE ? THEN ${w * 4} WHEN LOWER(c.keywords) LIKE ? THEN ${w * 3} WHEN LOWER(c.raw_text) LIKE ? THEN ${w * 3} ELSE 0 END)`
      }
      if (term.length === 3) {
        const w = 5
        return `(CASE WHEN LOWER(c.section_path) LIKE ? OR LOWER(c.entities) LIKE ? THEN ${w * 4} WHEN LOWER(c.keywords) LIKE ? THEN ${w * 3} WHEN LOWER(c.raw_text) LIKE ? THEN ${w * 3} ELSE 0 END)`
      }
      const w = 2
      return `(CASE WHEN LOWER(c.section_path) LIKE ? OR LOWER(c.entities) LIKE ? THEN ${w * 3} WHEN LOWER(c.keywords) LIKE ? THEN ${w * 2} WHEN LOWER(c.raw_text) LIKE ? THEN ${w} ELSE 0 END)`
    })

    const termConditions = uniqueTerms
      .map(
        () =>
          '(LOWER(c.raw_text) LIKE ? OR LOWER(c.section_path) LIKE ? OR LOWER(c.entities) LIKE ? OR LOWER(c.keywords) LIKE ?)'
      )
      .join(' OR ')

    // Trigram tokenizer needs at least three characters per phrase, so shorter terms can only
    // widen the score — UNLESS we unite them with the indexed term lookup for exact 2-char
    // entities (e.g. "方正", "酒虫", "红莲"). When no FTS term exists and the inverted term
    // index is populated, query the term index first before falling back to a full LIKE scan.
    const ftsTerms = this.ftsEnabled ? uniqueTerms.filter((term) => term.length >= 3) : []
    const shortTerms = uniqueTerms.filter((term) => term.length === 2)
    const useFts = ftsTerms.length > 0
    const ftsQuery = ftsTerms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100))

    const runRecallQuery = async (
      mode: 'fts' | 'fts_plus_short_terms' | 'terms' | 'like'
    ): Promise<Record<string, unknown>[]> => {
      let recallPredicate: string
      const predicateParams: unknown[] = []
      if (mode === 'fts') {
        recallPredicate = 'c.id IN (SELECT rowid FROM session_attachment_chunk_fts WHERE session_attachment_chunk_fts MATCH ?)'
        predicateParams.push(ftsQuery)
      } else if (mode === 'fts_plus_short_terms') {
        const shortPlaceholders = shortTerms.map(() => '?').join(',')
        recallPredicate = `(c.id IN (SELECT rowid FROM session_attachment_chunk_fts WHERE session_attachment_chunk_fts MATCH ?) OR c.id IN (SELECT chunk_id FROM session_attachment_term WHERE attachment_id IN (${placeholders}) AND term IN (${shortPlaceholders})))`
        predicateParams.push(ftsQuery, ...attachmentIds, ...shortTerms)
      } else if (mode === 'terms') {
        const termPlaceholders = uniqueTerms.map(() => '?').join(',')
        recallPredicate = `c.id IN (SELECT chunk_id FROM session_attachment_term WHERE attachment_id IN (${placeholders}) AND term IN (${termPlaceholders}))`
        predicateParams.push(...attachmentIds, ...uniqueTerms)
      } else {
        recallPredicate = `(${termConditions})`
        for (const term of uniqueTerms) {
          const pattern = `%${term}%`
          predicateParams.push(pattern, pattern, pattern, pattern)
        }
      }

      let sql = `
        SELECT c.*, a.filename, (${scoreExpressions.join(' + ')}) AS sql_match_score
        FROM session_attachment_chunk c
        JOIN session_attachment a ON c.attachment_id = a.id
        WHERE c.attachment_id IN (${placeholders})
          AND ${recallPredicate}
      `
      const params: unknown[] = []
      for (const term of uniqueTerms) {
        const pattern = `%${term}%`
        params.push(pattern, pattern, pattern, pattern)
      }
      params.push(...attachmentIds, ...predicateParams)

      // Drop raw metadata stubs (entity candidates / provenance lines). They are machine bookkeeping,
      // not canon content, yet they carry a high priority rank and would otherwise crowd the top-k.
      if (options.excludeMetadataFragments !== false) {
        sql += ` AND NOT (${METADATA_FRAGMENT_PATTERNS.map(() => 'c.raw_text LIKE ?').join(' OR ')})`
        params.push(...METADATA_FRAGMENT_PATTERNS)
      }

      // Push both the upper chapter ceiling AND phase-bound snapshot [valid_from, valid_to]
      // filtering into SQL so expired snapshots cannot monopolize the pre-LIMIT candidate window.
      if (options.maxChapter !== undefined && Number.isFinite(options.maxChapter)) {
        sql += options.includeUnknownChapter
          ? ' AND (c.chapter_order IS NULL OR c.chapter_order <= ?)'
          : ' AND c.chapter_order IS NOT NULL AND c.chapter_order <= ?'
        params.push(options.maxChapter)

        sql += ` AND (
          c.state_kind IS NULL
          OR c.state_kind NOT IN ('snapshot', 'item_state', 'relationship')
          OR (
            (c.valid_from IS NULL OR c.valid_from <= ?)
            AND (c.valid_to IS NULL OR c.valid_to >= ?)
          )
        )`
        params.push(options.maxChapter, options.maxChapter)
      }

      sql += ` ORDER BY CASE WHEN c.priority_rank = 0 THEN 0 ELSE 1 END DESC, sql_match_score DESC, c.priority_rank DESC, c.id ASC LIMIT ${limit}`
      const res = await this.database.query(sql, params)
      return res.values ?? []
    }

    let rows: Record<string, unknown>[]
    if (useFts) {
      const ftsMode = shortTerms.length > 0 && this.hasTermIndex ? 'fts_plus_short_terms' : 'fts'
      rows = await runRecallQuery(ftsMode)
    } else if (this.hasTermIndex) {
      const termRows = await runRecallQuery('terms')
      if (termRows.length >= Math.min(limit, 5)) {
        rows = termRows
      } else {
        const likeRows = await runRecallQuery('like')
        const byId = new Map<number, Record<string, unknown>>()
        for (const r of termRows) byId.set(Number(r.id), r)
        for (const r of likeRows) {
          const rid = Number(r.id)
          if (!byId.has(rid)) byId.set(rid, r)
        }
        rows = Array.from(byId.values())
      }
    } else {
      rows = await runRecallQuery('like')
    }

    const getTermWeight = (term: string): number => {
      if (hasSpecificTerm && genericHighFreq.has(term)) return 0.35
      if (entitySet.has(term) || term.length >= 4) return 4.0
      return term.length === 3 ? 3.0 : 1.5
    }

    const totalPossibleWeight = uniqueTerms.reduce((acc, term) => acc + getTermWeight(term), 0)

    const scored = rows.map((row) => {
      const chunk = mapRowToChunkRecord(row)
      const sectionAndEntities = `${chunk.sectionPath || ''} ${(chunk.entities || []).join(' ')}`.toLowerCase()
      const keywordsText = (chunk.keywords || []).join(' ').toLowerCase()
      const rawTextLower = chunk.rawText.toLowerCase()

      let weightedHits = 0
      let specificEntityHit = false
      for (const term of uniqueTerms) {
        const w = getTermWeight(term)
        const isSpecific = !hasSpecificTerm || !genericHighFreq.has(term)
        if (sectionAndEntities.includes(term)) {
          weightedHits += w
          if (term.length >= 2 && isSpecific) specificEntityHit = true
        } else if (keywordsText.includes(term)) {
          weightedHits += w * 0.9
          if (term.length >= 2 && isSpecific) specificEntityHit = true
        } else if (rawTextLower.includes(term)) {
          weightedHits += w * 0.8
          if ((entitySet.has(term) || term.length >= 3) && isSpecific) specificEntityHit = true
        }
      }
      const rawRatio = totalPossibleWeight > 0 ? weightedHits / totalPossibleWeight : 0
      const matchScore = Math.min(1.0, specificEntityHit ? Math.max(0.48, rawRatio * 1.35) : rawRatio)
      return {
        ...chunk,
        filename: String(row.filename),
        matchScore,
      }
    })

    return scored
      .sort((a, b) => b.matchScore - a.matchScore || (b.priorityRank ?? 2) - (a.priorityRank ?? 2) || a.id - b.id)
      .slice(0, limit)
  }

  public async listChunks(attachmentId: number): Promise<SessionAttachmentChunkRecord[]> {
    await this.initialize()
    const result = await this.database.query(
      'SELECT * FROM session_attachment_chunk WHERE attachment_id = ? ORDER BY chunk_order ASC',
      [attachmentId]
    )
    return (result.values ?? []).map(mapRowToChunkRecord)
  }

  public async listChunksWithDetails(
    chunkIds: number[]
  ): Promise<Array<SessionAttachmentChunkRecord & { filename: string }>> {
    if (chunkIds.length === 0) return []
    await this.initialize()
    const placeholders = chunkIds.map(() => '?').join(',')
    const result = await this.database.query(
      `SELECT c.*, a.filename
       FROM session_attachment_chunk c
       JOIN session_attachment a ON c.attachment_id = a.id
       WHERE c.id IN (${placeholders})`,
      chunkIds
    )
    return (result.values ?? []).map((row) => ({
      ...mapRowToChunkRecord(row),
      filename: String(row.filename),
    }))
  }

  public async readParents(
    parentIds: number[],
    allowedAttachmentIds: number[]
  ): Promise<SessionAttachmentParent[]> {
    if (parentIds.length === 0 || allowedAttachmentIds.length === 0) return []
    await this.initialize()
    const parentPlaceholders = parentIds.map(() => '?').join(',')
    const attachmentPlaceholders = allowedAttachmentIds.map(() => '?').join(',')
    const result = await this.database.query(
      `SELECT p.*, a.filename
       FROM session_attachment_parent p
       JOIN session_attachment a ON p.attachment_id = a.id
       WHERE p.id IN (${parentPlaceholders}) AND p.attachment_id IN (${attachmentPlaceholders})`,
      [...parentIds, ...allowedAttachmentIds]
    )
    return (result.values ?? []).map((row) => ({
      ...mapRowToParentRecord(row),
      filename: String(row.filename),
    }))
  }

  public async clearAll(): Promise<number> {
    await this.initialize()
    const countRes = await this.database.query('SELECT count(*) as cnt FROM session_attachment')
    const count = Number(countRes.values?.[0]?.cnt ?? 0)
    await this.database.executeSet([
      { statement: 'DELETE FROM session_attachment_term', values: [] },
      { statement: 'DELETE FROM session_attachment_vector', values: [] },
      { statement: 'DELETE FROM session_attachment_chunk', values: [] },
      { statement: 'DELETE FROM session_attachment_parent', values: [] },
      { statement: 'DELETE FROM session_attachment', values: [] },
    ])
    this.hasTermIndex = false
    await this.rebuildFtsIndex()
    return count
  }

  public async cleanupOrphans(
    sessionIds: string[],
    messageIds: string[],
    attachmentReferences: Array<{ attachmentId: number; sessionId: string; messageId: string }> = []
  ): Promise<number[]> {
    await this.initialize()
    const allAttachmentsResult = await this.database.query(
      'SELECT id, session_id, message_id FROM session_attachment'
    )
    const records = (allAttachmentsResult.values ?? []).map((r) => ({
      id: Number(r.id),
      sessionId: String(r.session_id),
      messageId: String(r.message_id),
    }))

    const cleanupPlan = planOrphanCleanup(records, {
      sessionIds,
      messageIds,
      attachmentReferences,
    })

    for (const repair of cleanupPlan.repairs) {
      await this.rebindAttachment(repair.attachmentId, repair.sessionId, repair.messageId)
    }

    for (const id of cleanupPlan.deleteIds) {
      await this.deleteAttachment(id)
    }

    return cleanupPlan.deleteIds
  }

  public async getDebugSnapshot(): Promise<SessionAttachmentRagDebugSnapshot> {
    await this.initialize()
    const [attachmentCountRes, parentCountRes, chunkCountRes, statusCountsRes, recentAttachmentsRes] =
      await Promise.all([
        this.database.query('SELECT count(*) as cnt FROM session_attachment'),
        this.database.query('SELECT count(*) as cnt FROM session_attachment_parent'),
        this.database.query('SELECT count(*) as cnt FROM session_attachment_chunk'),
        this.database.query(
          `SELECT
            sum(case when status = 'pending' then 1 else 0 end) as pending,
            sum(case when status = 'indexing' then 1 else 0 end) as indexing,
            sum(case when status = 'ready' then 1 else 0 end) as ready,
            sum(case when status = 'failed' then 1 else 0 end) as failed
           FROM session_attachment`
        ),
        this.database.query(
          'SELECT * FROM session_attachment ORDER BY id DESC LIMIT 10'
        ),
      ])

    const statusRow = statusCountsRes.values?.[0] ?? {}
    const recent = (recentAttachmentsRes.values ?? [])
      .map(mapRowToAttachmentRecord)
      .map((a) => ({
        ...a,
        chunkCount: a.chunkCount ?? 0,
        createdAt: a.createdAt ? Number(a.createdAt) : undefined,
        processingStartedAt: a.processingStartedAt ? Number(a.processingStartedAt) : undefined,
        completedAt: a.completedAt ? Number(a.completedAt) : undefined,
        status: (a.status === 'canceled' ? 'failed' : a.status) as 'pending' | 'indexing' | 'ready' | 'failed',
      }))

    return {
      dbPath: DB_NAME,
      dbSizeBytes: 0,
      vectorDbPath: DB_NAME,
      vectorDbSizeBytes: 0,
      attachmentCount: Number(attachmentCountRes.values?.[0]?.cnt ?? 0),
      parentCount: Number(parentCountRes.values?.[0]?.cnt ?? 0),
      chunkCount: Number(chunkCountRes.values?.[0]?.cnt ?? 0),
      vectorIndexNames: [],
      statusCounts: {
        pending: Number(statusRow.pending ?? 0),
        indexing: Number(statusRow.indexing ?? 0),
        ready: Number(statusRow.ready ?? 0),
        failed: Number(statusRow.failed ?? 0),
      },
      recentAttachments: recent,
    }
  }
}
