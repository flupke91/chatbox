import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import localforage from 'localforage'

/**
 * Minimal adapter that makes sql.js (SQLite compiled to WebAssembly) look like the
 * Capacitor SQLite connection object that MobileRagDatabase expects.
 *
 * The browser has no native SQLite, so the whole database lives in the wasm heap and is
 * snapshotted into IndexedDB after writes settle. That keeps a single code path shared with
 * Android/iOS — the schema, migrations, scoring SQL and FTS fallback all stay identical.
 */
const PERSIST_KEY = 'session-attachment-rag:sqlite'
const SAVE_DEBOUNCE_MS = 1200

export interface SqlJsPersistence {
  load(): Promise<Uint8Array | null>
  save(bytes: Uint8Array): Promise<void>
}

/** Default persistence: the whole SQLite file is snapshotted into IndexedDB. */
export const indexedDbPersistence: SqlJsPersistence = {
  async load() {
    const stored = await localforage.getItem<Uint8Array>(PERSIST_KEY)
    return stored && stored.byteLength > 0 ? new Uint8Array(stored) : null
  },
  async save(bytes) {
    await localforage.setItem(PERSIST_KEY, bytes)
  },
}

export function createMemoryPersistence(): SqlJsPersistence {
  let stored: Uint8Array | null = null
  return {
    async load() {
      return stored
    },
    async save(bytes) {
      stored = bytes
    },
  }
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({ locateFile: () => wasmUrl })
  }
  return sqlJsPromise
}

type Row = Record<string, unknown>

export class SqlJsDatabase {
  private db: Database | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> = Promise.resolve()

  constructor(private persistence: SqlJsPersistence = indexedDbPersistence) {
    if (typeof window !== 'undefined') {
      // The debounced snapshot can otherwise be lost when the tab is closed right after an
      // import finishes; flush synchronously-ish on hide/unload.
      const flushOnHide = () => {
        void this.flush()
      }
      window.addEventListener('pagehide', flushOnHide)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushOnHide()
      })
    }
  }

  public async open(): Promise<void> {
    if (this.db) return
    const SQL = await loadSqlJs()
    const persisted = await this.persistence.load()
    this.db = persisted && persisted.byteLength > 0 ? new SQL.Database(new Uint8Array(persisted)) : new SQL.Database()
  }

  public async close(): Promise<void> {
    await this.flush()
    this.db?.close()
    this.db = null
  }

  private requireDb(): Database {
    if (!this.db) throw new Error('sql.js database is not open')
    return this.db
  }

  public async query(statement: string, values: unknown[] = []): Promise<{ values: Row[] }> {
    const db = this.requireDb()
    const stmt = db.prepare(statement)
    try {
      if (values.length > 0) stmt.bind(values as never[])
      const rows: Row[] = []
      while (stmt.step()) rows.push(stmt.getAsObject() as Row)
      return { values: rows }
    } finally {
      stmt.free()
    }
  }

  public async run(statement: string, values: unknown[] = []): Promise<{ changes: { changes: number; lastId: number } }> {
    const db = this.requireDb()
    db.run(statement, values as never[])
    const lastIdRow = db.exec('SELECT last_insert_rowid() AS id')
    const lastId = Number(lastIdRow[0]?.values?.[0]?.[0] ?? 0)
    const changes = db.getRowsModified()
    this.scheduleSave()
    return { changes: { changes, lastId } }
  }

  public async execute(statements: string): Promise<{ changes: { changes: number } }> {
    const db = this.requireDb()
    // exec() accepts multiple ";"-separated statements, which is what the schema bootstrap uses.
    db.exec(statements)
    const changes = db.getRowsModified()
    this.scheduleSave()
    return { changes: { changes } }
  }

  public async executeSet(
    set: Array<{ statement: string; values?: unknown[] }>
  ): Promise<{ changes: { changes: number } }> {
    const db = this.requireDb()
    db.run('BEGIN')
    try {
      for (const item of set) {
        db.run(item.statement, (item.values ?? []) as never[])
      }
      db.run('COMMIT')
    } catch (error) {
      try {
        db.run('ROLLBACK')
      } catch {
        // ignore rollback failures
      }
      throw error
    }
    const changes = db.getRowsModified()
    this.scheduleSave()
    return { changes: { changes } }
  }

  /** Coalesce the expensive export() into one write once the import burst settles. */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, SAVE_DEBOUNCE_MS)
  }

  public async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    const db = this.db
    if (!db) return
    const bytes = db.export()
    this.saving = this.saving.then(async () => {
      await this.persistence.save(bytes)
    })
    await this.saving
  }
}

/**
 * Stand-in for Capacitor's SQLiteConnection: MobileRagDatabase only needs create/close.
 */
export class SqlJsConnection {
  private connection: SqlJsDatabase | null = null

  constructor(private persistence?: SqlJsPersistence) {}

  public async createConnection(): Promise<SqlJsDatabase> {
    if (!this.connection) {
      this.connection = new SqlJsDatabase(this.persistence)
      await this.connection.open()
    }
    return this.connection
  }

  public async closeConnection(): Promise<void> {
    await this.connection?.close()
    this.connection = null
  }

  public async flush(): Promise<void> {
    await this.connection?.flush()
  }
}
