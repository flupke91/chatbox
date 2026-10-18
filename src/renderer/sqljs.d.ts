declare module 'sql.js' {
  export interface Statement {
    bind(values?: unknown[]): boolean
    step(): boolean
    getAsObject(): Record<string, unknown>
    free(): boolean
  }

  export interface SqlJsQueryResult {
    columns: string[]
    values: unknown[][]
  }

  export interface Database {
    run(sql: string, params?: unknown[]): Database
    exec(sql: string): SqlJsQueryResult[]
    prepare(sql: string): Statement
    export(): Uint8Array
    close(): void
    getRowsModified(): number
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array | null) => Database
  }

  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>
}
