// Types for schema.mjs, which the app imports for its "Seed sample database" dialog.
export type SeedDialect = 'pg' | 'mysql' | 'mssql' | 'sqlite'

export interface TableDef {
  pk: string[]
  /** Column name to type spec, in CSV/insert order */
  cols: Record<string, string>
  fk?: Record<string, string>
  unique?: string[][]
  idx?: string[][]
}

export const ENUMS: Record<string, string[]>
export const TABLES: Record<string, TableDef>
export const COLUMNS: Record<string, string[]>
export function tablesDdl(d: SeedDialect): string
export function postDdl(d: SeedDialect): string
export function sqliteTablesDdl(): string
