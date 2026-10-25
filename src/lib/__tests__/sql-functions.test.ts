import { describe, expect, it } from 'vitest'
import type { ServerVersion } from '../mariadb'
import { functionsFor } from '../sql-functions'
import { MARIADB_FUNCTIONS } from '../sql-functions-mariadb'

const names = (version?: ServerVersion, dialect: 'mysql' | 'postgres' = 'mysql'): string[] =>
  functionsFor(dialect, version).map((f) => f.name)
const fn = (name: string, version?: ServerVersion) =>
  functionsFor('mysql', version).find((f) => f.name === name)

const MARIADB_ONLY = [
  'nextval',
  'lastval',
  'setval',
  'json_table',
  'json_equals',
  'json_normalize',
  'json_overlaps',
  'json_schema_valid',
  'json_key_value',
  'json_array_intersect',
  'json_object_filter_keys',
  'json_object_to_array',
  'natural_sort_key',
  'sformat',
  'uuid_v4',
  'uuid_v7',
  'vec_fromtext',
  'vec_totext',
  'vec_distance_euclidean',
  'vec_distance_cosine',
  'vec_distance'
]

describe('MariaDB function catalog', () => {
  it('keeps MariaDB-only functions out of MySQL and other dialects', () => {
    for (const name of MARIADB_ONLY) expect(names()).not.toContain(name)
    // PostgreSQL has its own nextval, json_table…; MariaDB's entries stay out, even with a
    // MariaDB version, which only applies to the MySQL dialect
    const maria = new Set(MARIADB_FUNCTIONS)
    for (const version of [undefined, [11, 8, 0] as ServerVersion]) {
      const leaked = functionsFor('postgres', version).filter(
        (f) => maria.has(f) && MARIADB_ONLY.includes(f.name)
      )
      expect(leaked).toEqual([])
    }
  })

  it('offers them on MariaDB 11.8', () => {
    expect(names([11, 8, 0])).toEqual(expect.arrayContaining(MARIADB_ONLY))
    // Shared functions stay
    expect(names([11, 8, 0])).toEqual(expect.arrayContaining(['group_concat', 'json_extract']))
  })

  it('filters by the version that added them', () => {
    const v106 = names([10, 6, 12])
    expect(v106).toEqual(expect.arrayContaining(['json_table', 'nextval']))
    for (const name of ['natural_sort_key', 'sformat', 'json_overlaps', 'uuid_v7', 'vec_distance'])
      expect(v106).not.toContain(name)
    expect(names([10, 2, 0])).not.toContain('nextval')
    expect(names([11, 1, 0])).toContain('json_schema_valid')
    expect(names([11, 1, 0])).not.toContain('json_key_value')
    expect(names([11, 7, 0])).toEqual(expect.arrayContaining(['uuid_v4', 'vec_fromtext']))
  })

  it('uses MariaDB signatures where they differ from MySQL', () => {
    expect(fn('regexp_replace')?.params).toHaveLength(6)
    expect(fn('regexp_replace', [11, 8, 0])?.params).toEqual(['string', 'pattern', 'replacement'])
    expect(fn('lag')?.params).toContain('default')
    expect(fn('lag', [11, 8, 0])?.params).toEqual(['expression', 'offset'])
    expect(functionsFor('postgres').find((f) => f.name === 'regexp_replace')?.params).toContain(
      'flags'
    )
    // One entry per name
    const all = names([11, 8, 0])
    expect(new Set(all).size).toBe(all.length)
  })

  it('flags every MariaDB entry and gives JSON_TABLE a COLUMNS snippet', () => {
    for (const f of MARIADB_FUNCTIONS) {
      expect(f.onlyMariaDb).toBe(true)
      expect(f.dialects).toEqual(['mysql'])
    }
    expect(fn('json_table', [11, 8, 0])?.snippet).toMatch(/COLUMNS \(.* PATH /)
  })
})
