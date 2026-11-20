import { describe, expect, it, vi } from 'vitest'
import { SqlJsDatabase, type SqlJsPersistence } from '../sqljs-adapter'

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const path = await import('node:path')
  return { default: path.resolve(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm') }
})

describe('SqlJsDatabase', () => {
  it('skips export and IndexedDB persistence on flush() when database is clean', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const persistence: SqlJsPersistence = {
      load: vi.fn().mockResolvedValue(null),
      save,
    }
    const db = new SqlJsDatabase(persistence)
    await db.open()
    await db.flush()
    expect(save).not.toHaveBeenCalled()

    await db.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);')
    await db.flush()
    expect(save).toHaveBeenCalledTimes(1)

    await db.query('SELECT * FROM items')
    await db.flush()
    expect(save).toHaveBeenCalledTimes(1)

    await db.close()
  })

  it('recovers cleanly after a persistence.save failure and retries on subsequent flush', async () => {
    let failNext = true
    let latestBytes: Uint8Array | null = null
    const save = vi.fn().mockImplementation(async (bytes: Uint8Array) => {
      if (failNext) {
        failNext = false
        throw new Error('QuotaExceededError')
      }
      latestBytes = bytes
    })
    const persistence: SqlJsPersistence = {
      load: vi.fn().mockResolvedValue(null),
      save,
    }

    const db = new SqlJsDatabase(persistence)
    await db.open()
    await db.execute('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);')
    await db.run('INSERT INTO kv (k, v) VALUES (?, ?)', ['hero', 'Fang Yuan'])

    await expect(db.flush()).rejects.toThrow('QuotaExceededError')
    await expect(db.flush()).resolves.toBeUndefined()
    expect(save).toHaveBeenCalledTimes(2)
    expect(latestBytes).not.toBeNull()

    await db.close()
  })

  it('batches repeated SQL statements in executeSet and rolls back atomically on error', async () => {
    const persistence: SqlJsPersistence = {
      load: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
    }

    const db = new SqlJsDatabase(persistence)
    await db.open()
    await db.execute('CREATE TABLE nums (id INTEGER PRIMARY KEY, val TEXT NOT NULL);')

    await db.executeSet([
      { statement: 'INSERT INTO nums (id, val) VALUES (?, ?)', values: [1, 'a'] },
      { statement: 'INSERT INTO nums (id, val) VALUES (?, ?)', values: [2, 'b'] },
      { statement: 'INSERT INTO nums (id, val) VALUES (?, ?)', values: [3, 'c'] },
    ])
    const res1 = await db.query('SELECT val FROM nums ORDER BY id ASC')
    expect(res1.values.map((r) => r.val)).toEqual(['a', 'b', 'c'])

    await expect(
      db.executeSet([
        { statement: 'INSERT INTO nums (id, val) VALUES (?, ?)', values: [4, 'd'] },
        { statement: 'INSERT INTO nums (id, val) VALUES (?, ?)', values: [4, 'duplicate-pk'] },
      ])
    ).rejects.toThrow()

    const res2 = await db.query('SELECT count(*) as cnt FROM nums')
    expect(res2.values[0]?.cnt).toBe(3)

    await db.close()
  })
})
