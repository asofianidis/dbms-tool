import { describe, expect, it } from 'vitest'
import type { ColumnInfo, TableInfo } from '../api'
import {
  draftFromTable,
  newColumn,
  newIndex,
  newTableDraft,
  newUnique,
  tableStatements,
  type TableDraft
} from '../ddl'
import {
  boundClause,
  countPgOptionChanges,
  exclusionClause,
  needsBtreeGist,
  newExclusion,
  newParameter,
  newPartition,
  newPgTableOptions,
  parsePgTableContext,
  pgTableOptionProblem,
  pgTableOptionWarnings,
  withPgTableOptions,
  type PgTableContext,
  type PgTableOptions
} from '../pg-table-options'
import { extrasQueries, parseExtras } from '../table-extras'

const column = (patch: Partial<ColumnInfo> & { name: string }): ColumnInfo => ({
  dataType: 'integer',
  nullable: true,
  default: null,
  isPrimaryKey: false,
  isGenerated: false,
  isIdentity: false,
  comment: null,
  extra: null,
  ...patch
})

/** bookings(id, room, during) with an exclusion constraint and its backing index. */
const bookingsTable: TableInfo = {
  columns: [
    column({ name: 'id', nullable: false, isPrimaryKey: true, isIdentity: true }),
    column({ name: 'room' }),
    column({ name: 'during', dataType: 'tstzrange' })
  ],
  primaryKey: ['id'],
  indexes: [
    {
      name: 'bookings_pkey',
      columns: ['id'],
      unique: true,
      primary: true,
      method: 'btree',
      definition: null
    },
    {
      name: 'bookings_room_during_excl',
      columns: ['room', 'during'],
      unique: false,
      primary: false,
      method: 'gist',
      definition:
        'CREATE INDEX bookings_room_during_excl ON public.bookings USING gist (room, during)'
    }
  ],
  foreignKeys: [],
  triggers: []
}

const server = (patch: Partial<PgTableContext> = {}): PgTableContext => ({
  version: 170002,
  tablespaces: ['pg_default', 'fast'],
  defaultTablespace: 'pg_default',
  btreeGist: { installed: false, available: true },
  original: null,
  partitionedBy: null,
  partitionColumns: [],
  partitionOf: null,
  ...patch
})

const tableRow = (patch: Partial<Record<number, string | null>> = {}): (string | null)[] => {
  const row: (string | null)[] = ['r', 'p', '[]', '[]', null, null, null, '[]', null]
  for (const [i, v] of Object.entries(patch)) row[Number(i)] = v ?? null
  return row
}

const serverRow = ['170002', '["fast","pg_default"]', 'pg_default', 'f', 't']

const loadBookings = (): { draft: TableDraft; context: PgTableContext } => {
  const extras = parseExtras(
    'postgres',
    {
      exclusions: [
        [
          'bookings_room_during_excl',
          'EXCLUDE USING gist (room WITH =, during WITH &&)',
          'bookings_room_during_excl',
          'f'
        ]
      ]
    },
    bookingsTable
  )
  const draft = draftFromTable('postgres', 'public', 'bookings', bookingsTable, extras)
  const context = parsePgTableContext(
    {
      server: [serverRow],
      table: [tableRow({ 2: '["fillfactor=70"]', 3: '["autovacuum_enabled=false"]', 5: 'Rooms' })],
      partitions: []
    },
    extras.exclusions
  )
  return { draft, context }
}

const script = (draft: TableDraft, options: PgTableOptions, context: PgTableContext): string[] =>
  withPgTableOptions(tableStatements('postgres', draft), draft, options, context)

/** A new events(id, created_at, region) table. */
const newEvents = (): TableDraft => {
  const draft = newTableDraft('postgres', 'public')
  draft.name = 'events'
  draft.columns.push(
    newColumn('postgres', { name: 'created_at', dataType: 'timestamptz', nullable: false }),
    newColumn('postgres', { name: 'region', dataType: 'text' })
  )
  return draft
}
const idOf = (draft: TableDraft, name: string): string =>
  draft.columns.find((c) => c.name === name)!.id

describe('exclusion constraints in the extras', () => {
  it('reads them and keeps their index out of the editable indexes', () => {
    expect(extrasQueries('postgres', 'public', 'bookings').exclusions).toMatch(/contype = 'x'/)
    const { draft, context } = loadBookings()
    expect(draft.indexes).toEqual([])
    expect(context.original!.exclusions).toHaveLength(1)
    expect(context.original!.exclusions[0].existing!.definition).toBe(
      'EXCLUDE USING gist (room WITH =, during WITH &&)'
    )
    // Other dialects have no exclusions query
    expect(extrasQueries('tsql', 'dbo', 't').exclusions).toBeUndefined()
    expect(extrasQueries('mysql', 'app', 't').exclusions).toBeUndefined()
  })

  it('leaves an unchanged table alone', () => {
    const { draft, context } = loadBookings()
    expect(script(draft, context.original!, context)).toEqual([])
    expect(countPgOptionChanges(draft, context.original!, context.original)).toBe(0)
  })

  it('drops an existing one before the column changes', () => {
    const { draft, context } = loadBookings()
    draft.columns.find((c) => c.name === 'room')!.dropped = true
    const options = {
      ...context.original!,
      exclusions: context.original!.exclusions.map((x) => ({ ...x, dropped: true }))
    }
    expect(script(draft, options, context)).toEqual([
      'ALTER TABLE public.bookings DROP CONSTRAINT bookings_room_during_excl',
      'ALTER TABLE public.bookings DROP COLUMN room'
    ])
  })
})

describe('new exclusion constraints', () => {
  it('writes elements, INCLUDE, WHERE and DEFERRABLE', () => {
    const { draft } = loadBookings()
    const x = newExclusion({
      elements: [
        { expression: 'room', operator: '=' },
        { expression: 'during', operator: '&&' }
      ],
      include: [idOf(draft, 'id')],
      where: 'room > 0',
      deferrable: 'DEFERRABLE INITIALLY DEFERRED'
    })
    expect(exclusionClause(draft, x)).toBe(
      'CONSTRAINT ex_bookings_room_during EXCLUDE USING gist (room WITH =, during WITH &&) INCLUDE (id) WHERE (room > 0) DEFERRABLE INITIALLY DEFERRED'
    )
    // Expressions are parenthesised, odd column names quoted
    draft.columns.push(newColumn('postgres', { name: 'Ends', dataType: 'timestamptz' }))
    const y = newExclusion({
      name: 'no_overlap',
      method: 'spgist',
      elements: [
        { expression: 'tstzrange(lower(during), "Ends")', operator: '&&' },
        { expression: 'Ends', operator: '=' }
      ]
    })
    expect(exclusionClause(draft, y)).toBe(
      'CONSTRAINT no_overlap EXCLUDE USING spgist ((tstzrange(lower(during), "Ends")) WITH &&, "Ends" WITH =)'
    )
  })

  it('offers btree_gist for scalar equality and warns about the lock', () => {
    const { draft, context } = loadBookings()
    const x = newExclusion({
      name: 'ex2',
      elements: [
        { expression: 'room', operator: '=' },
        { expression: 'during', operator: '&&' }
      ]
    })
    const options = { ...context.original!, exclusions: [...context.original!.exclusions, x] }
    expect(needsBtreeGist(draft, options)).toEqual([x])
    const statements = script(draft, options, context)
    expect(statements).toEqual([
      'CREATE EXTENSION IF NOT EXISTS btree_gist',
      'ALTER TABLE public.bookings ADD CONSTRAINT ex2 EXCLUDE USING gist (room WITH =, during WITH &&)'
    ])
    expect(pgTableOptionWarnings(draft, options, context).join('\n')).toMatch(
      /btree_gist[\s\S]*ex2 builds its index under an ACCESS EXCLUSIVE lock/
    )
    expect(pgTableOptionProblem(draft, options, context, statements)).toBeNull()
    // Without the extension script, the constraint can't be created
    const off = { ...options, installBtreeGist: false }
    expect(script(draft, off, context)[0]).not.toMatch(/btree_gist/)
    expect(pgTableOptionProblem(draft, off, context, [])).toMatch(/needs the btree_gist extension/)
    // Already installed: nothing to add
    const installed = { ...context, btreeGist: { installed: true, available: true } }
    expect(script(draft, options, installed)[0]).not.toMatch(/btree_gist/)
    // Ranges compare natively
    const ranges = {
      ...options,
      exclusions: [newExclusion({ elements: [{ expression: 'during', operator: '=' }] })]
    }
    expect(needsBtreeGist(draft, ranges)).toEqual([])
    // Not available on the server
    const missing = { ...context, btreeGist: { installed: false, available: false } }
    expect(pgTableOptionProblem(draft, options, missing, [])).toMatch(/doesn't have/)
  })

  it('validates elements and operators', () => {
    const { draft, context } = loadBookings()
    const opts = (x: Parameters<typeof newExclusion>[0]): PgTableOptions => ({
      ...context.original!,
      exclusions: [newExclusion({ name: 'e', ...x })]
    })
    expect(
      pgTableOptionProblem(
        draft,
        opts({ elements: [{ expression: '', operator: '=' }] }),
        context,
        []
      )
    ).toMatch(/Enter the columns/)
    expect(
      pgTableOptionProblem(
        draft,
        opts({ elements: [{ expression: 'during', operator: '; drop' }] }),
        context,
        []
      )
    ).toMatch(/Enter an operator/)
  })
})

describe('partitioning a new table', () => {
  it('adds PARTITION BY and creates partitions after the table', () => {
    const draft = newEvents()
    draft.primaryKey.push(idOf(draft, 'created_at'))
    const options: PgTableOptions = {
      ...newPgTableOptions(),
      partitionKey: { strategy: 'RANGE', columns: [idOf(draft, 'created_at')], expression: '' },
      partitions: [
        newPartition({ name: 'events_2025', from: "'2025-01-01'", to: "'2026-01-01'" }),
        newPartition({ name: 'events_default', isDefault: true }),
        newPartition({
          mode: 'attach',
          schema: 'public',
          name: 'events_old',
          from: 'MINVALUE',
          to: "'2025-01-01'"
        })
      ],
      comment: "Everything's logged"
    }
    const context = server()
    const statements = script(draft, options, context)
    expect(statements[0]).toBe(
      'CREATE TABLE public.events (\n  id bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  created_at timestamptz NOT NULL,\n  region text,\n  PRIMARY KEY (id, created_at)\n) PARTITION BY RANGE (created_at)'
    )
    expect(statements.slice(1)).toEqual([
      "COMMENT ON TABLE public.events IS 'Everything''s logged'",
      "CREATE TABLE public.events_2025 PARTITION OF public.events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')",
      'CREATE TABLE public.events_default PARTITION OF public.events DEFAULT',
      "ALTER TABLE public.events ATTACH PARTITION public.events_old FOR VALUES FROM (MINVALUE) TO ('2025-01-01')"
    ])
    expect(pgTableOptionProblem(draft, options, context, statements)).toBeNull()
    expect(pgTableOptionWarnings(draft, options, context).join('\n')).toMatch(
      /Attaching events_old scans it/
    )
  })

  it('requires the key in the primary key, uniques and unique indexes', () => {
    const draft = newEvents()
    const key = { strategy: 'RANGE' as const, columns: [idOf(draft, 'created_at')], expression: '' }
    const options = { ...newPgTableOptions(), partitionKey: key }
    expect(pgTableOptionProblem(draft, options, server(), [])).toBe(
      'The primary key must include the partition key (created_at)'
    )
    draft.primaryKey = []
    expect(pgTableOptionProblem(draft, options, server(), [])).toBeNull()
    draft.uniques.push(newUnique({ name: 'uq_region', columns: [idOf(draft, 'region')] }))
    expect(pgTableOptionProblem(draft, options, server(), [])).toMatch(
      /^Unique constraint uq_region must include the partition key/
    )
    draft.uniques = []
    draft.indexes.push(
      newIndex({ name: 'ux_region', unique: true, columns: [idOf(draft, 'region')] })
    )
    expect(pgTableOptionProblem(draft, options, server(), [])).toMatch(/^Unique index ux_region/)
    draft.indexes = []
    // Expression keys rule out unique constraints altogether
    draft.primaryKey = [idOf(draft, 'id')]
    const byExpression = {
      ...options,
      partitionKey: { strategy: 'LIST' as const, columns: [], expression: 'lower(region)' }
    }
    expect(pgTableOptionProblem(draft, byExpression, server(), [])).toMatch(
      /partitioned by an expression/
    )
    draft.primaryKey = []
    expect(script(draft, byExpression, server())[0]).toMatch(
      /\) PARTITION BY LIST \(\(lower\(region\)\)\)$/
    )
    expect(
      pgTableOptionProblem(
        draft,
        { ...options, partitionKey: { ...key, columns: [] } },
        server(),
        []
      )
    ).toMatch(/Pick the partition key/)
    expect(
      pgTableOptionProblem(
        draft,
        {
          ...options,
          partitionKey: {
            strategy: 'LIST',
            columns: [idOf(draft, 'region'), idOf(draft, 'id')],
            expression: ''
          }
        },
        server(),
        []
      )
    ).toMatch(/single key/)
  })

  it('rejects UNLOGGED and storage parameters on a partitioned table', () => {
    const draft = newEvents()
    draft.primaryKey = []
    const key = { strategy: 'HASH' as const, columns: [idOf(draft, 'id')], expression: '' }
    expect(
      pgTableOptionProblem(
        draft,
        { ...newPgTableOptions(), partitionKey: key, unlogged: true },
        server(),
        []
      )
    ).toMatch(/can't be unlogged/)
    expect(
      pgTableOptionProblem(
        draft,
        {
          ...newPgTableOptions(),
          partitionKey: key,
          parameters: [newParameter('fillfactor', '70')]
        },
        server(),
        []
      )
    ).toMatch(/no storage parameters/)
  })

  it('writes hash, list and default bounds', () => {
    const b = newPartition({ modulus: '4', remainder: '1', values: "'eu', 'uk'", isDefault: false })
    expect(boundClause('HASH', b)).toBe('FOR VALUES WITH (MODULUS 4, REMAINDER 1)')
    expect(boundClause('LIST', b)).toBe("FOR VALUES IN ('eu', 'uk')")
    expect(boundClause('LIST', { ...b, isDefault: true })).toBe('DEFAULT')
    // Hash partitioning has no default partition
    expect(boundClause('HASH', { ...b, isDefault: true })).toBe(
      'FOR VALUES WITH (MODULUS 4, REMAINDER 1)'
    )
  })

  it('validates partition bounds', () => {
    const draft = newEvents()
    draft.primaryKey = []
    const problem = (
      strategy: 'RANGE' | 'LIST' | 'HASH',
      patch: Parameters<typeof newPartition>[0]
    ) =>
      pgTableOptionProblem(
        draft,
        {
          ...newPgTableOptions(),
          partitionKey: { strategy, columns: [idOf(draft, 'id')], expression: '' },
          partitions: [newPartition({ name: 'p', ...patch })]
        },
        server(),
        []
      )
    expect(problem('RANGE', { from: '1' })).toMatch(/FROM and TO/)
    expect(problem('LIST', {})).toMatch(/values of p/)
    expect(problem('HASH', { modulus: '4', remainder: '4' })).toMatch(/less than its modulus/)
    expect(problem('HASH', { modulus: 'x', remainder: '0' })).toMatch(/whole-number/)
    expect(problem('RANGE', { name: '', isDefault: true })).toMatch(/Enter a name/)
    expect(problem('RANGE', { isDefault: true })).toBeNull()
  })

  it('needs PostgreSQL 17 and the key compared with = for exclusions on partitioned tables', () => {
    const draft = newEvents()
    draft.primaryKey = []
    draft.columns.push(newColumn('postgres', { name: 'during', dataType: 'tstzrange' }))
    const options: PgTableOptions = {
      ...newPgTableOptions(),
      partitionKey: { strategy: 'LIST', columns: [idOf(draft, 'region')], expression: '' },
      exclusions: [
        newExclusion({ name: 'e', elements: [{ expression: 'during', operator: '&&' }] })
      ]
    }
    expect(pgTableOptionProblem(draft, options, server({ version: 160004 }), [])).toMatch(
      /PostgreSQL 16 can't add exclusion constraints to partitioned tables/
    )
    expect(pgTableOptionProblem(draft, options, server(), [])).toMatch(
      /must compare the partition key \(region\)/
    )
    options.exclusions[0].elements.unshift({ expression: 'region', operator: '=' })
    expect(
      pgTableOptionProblem(draft, { ...options, installBtreeGist: true }, server(), [])
    ).toBeNull()
  })
})

describe('storage options', () => {
  it('writes UNLOGGED, WITH and TABLESPACE on a new table', () => {
    const draft = newEvents()
    const options: PgTableOptions = {
      ...newPgTableOptions(),
      unlogged: true,
      parameters: [
        newParameter('fillfactor', '80'),
        newParameter('toast.autovacuum_enabled', 'false')
      ],
      tablespace: 'fast'
    }
    const [create] = script(draft, options, server())
    expect(create).toMatch(/^CREATE UNLOGGED TABLE public\.events \(/)
    expect(create).toMatch(
      /\) WITH \(fillfactor = 80, toast\.autovacuum_enabled = false\) TABLESPACE fast$/
    )
    expect(pgTableOptionWarnings(draft, options, server())).toEqual([
      "Unlogged tables are emptied after a crash and aren't copied to standbys"
    ])
  })

  it('diffs persistence, parameters, tablespace and comment on an existing table', () => {
    const { draft, context } = loadBookings()
    const was = context.original!
    expect(was.parameters.map((p) => `${p.name}=${p.value}`)).toEqual([
      'fillfactor=70',
      'toast.autovacuum_enabled=false'
    ])
    expect(was.comment).toBe('Rooms')
    const options: PgTableOptions = {
      ...was,
      unlogged: true,
      parameters: [
        { ...was.parameters[0], value: '90' },
        newParameter('autovacuum_vacuum_scale_factor', '0.02')
      ],
      tablespace: 'fast',
      comment: ''
    }
    draft.name = 'reservations'
    const statements = script(draft, options, context)
    expect(statements).toEqual([
      'ALTER TABLE public.bookings RENAME TO reservations',
      'ALTER TABLE public.reservations SET UNLOGGED',
      'ALTER TABLE public.reservations SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02)',
      'ALTER TABLE public.reservations RESET (toast.autovacuum_enabled)',
      'ALTER TABLE public.reservations SET TABLESPACE fast',
      'COMMENT ON TABLE public.reservations IS NULL'
    ])
    expect(countPgOptionChanges(draft, options, was)).toBe(6)
    const warnings = pgTableOptionWarnings(draft, options, context).join('\n')
    expect(warnings).toMatch(/SET UNLOGGED rewrites the table under an ACCESS EXCLUSIVE lock/)
    expect(warnings).toMatch(/SET TABLESPACE rewrites the table/)
    // Back to the database default names it
    const back = script(
      draft,
      { ...was, tablespace: '' },
      { ...context, original: { ...was, tablespace: 'fast' } }
    )
    expect(back).toContain('ALTER TABLE public.reservations SET TABLESPACE pg_default')
  })

  it('validates parameter names and values', () => {
    const { draft, context } = loadBookings()
    const problem = (name: string, value: string) =>
      pgTableOptionProblem(
        draft,
        { ...context.original!, parameters: [newParameter(name, value)] },
        context,
        []
      )
    expect(problem('fillfactor', '')).toMatch(/Enter a value/)
    expect(problem('fill factor', '1')).toMatch(/isn't a valid storage parameter name/)
    expect(problem('fillfactor', '1); DROP TABLE x')).toMatch(/isn't a valid value/)
    expect(problem('fillfactor', '50')).toBeNull()
    expect(
      pgTableOptionProblem(
        draft,
        {
          ...context.original!,
          parameters: [newParameter('fillfactor', '50'), newParameter('FILLFACTOR', '60')]
        },
        context,
        []
      )
    ).toMatch(/set twice/)
  })
})

describe('partitions of an existing table', () => {
  const load = (version = 170002, partitions: (string | null)[][] = []) => {
    const info: TableInfo = {
      columns: [column({ name: 'id' }), column({ name: 'created_at', dataType: 'date' })],
      primaryKey: [],
      indexes: [],
      foreignKeys: [],
      triggers: []
    }
    const draft = draftFromTable('postgres', 'public', 'events', info)
    const context = parsePgTableContext({
      server: [[String(version), '[]', 'pg_default', 'f', 't']],
      table: [tableRow({ 0: 'p', 6: 'RANGE (created_at)', 7: '["created_at"]' })],
      partitions
    })
    return { draft, context }
  }
  const twoPartitions = [
    [
      'public',
      'events_2024',
      'partition',
      "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')",
      '10'
    ],
    ['public', 'events_default', 'partition', 'DEFAULT', '-1']
  ]

  it('reads the key and partitions', () => {
    const { context } = load(170002, twoPartitions)
    expect(context.partitionedBy).toBe('RANGE (created_at)')
    expect(context.partitionColumns).toEqual(['created_at'])
    expect(context.original!.existingPartitions.map((p) => [p.name, p.bound])).toEqual([
      ['events_2024', "FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')"],
      ['events_default', 'DEFAULT']
    ])
  })

  it('creates, attaches and detaches partitions', () => {
    const { draft, context } = load(170002, twoPartitions)
    const was = context.original!
    const options: PgTableOptions = {
      ...was,
      existingPartitions: was.existingPartitions.map((p, i) => ({ ...p, detach: i === 0 })),
      partitions: [
        newPartition({ name: 'events_2025', from: "'2025-01-01'", to: "'2026-01-01'" }),
        newPartition({
          mode: 'attach',
          schema: 'archive',
          name: 'events_2023',
          from: "'2023-01-01'",
          to: "'2024-01-01'"
        })
      ]
    }
    const statements = script(draft, options, context)
    expect(statements).toEqual([
      'ALTER TABLE public.events DETACH PARTITION public.events_2024',
      "CREATE TABLE public.events_2025 PARTITION OF public.events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')",
      "ALTER TABLE public.events ATTACH PARTITION archive.events_2023 FOR VALUES FROM ('2023-01-01') TO ('2024-01-01')"
    ])
    expect(countPgOptionChanges(draft, options, was)).toBe(3)
    const warnings = pgTableOptionWarnings(draft, options, context).join('\n')
    expect(warnings).toMatch(
      /Detaching events_2024 takes an ACCESS EXCLUSIVE lock on events; CONCURRENTLY/
    )
    expect(warnings).toMatch(/Creating events_2025 scans the default partition/)
    expect(warnings).toMatch(/the default partition is scanned too/)
    expect(pgTableOptionProblem(draft, options, context, statements)).toBeNull()
  })

  it('detaches concurrently only on its own, on PostgreSQL 14+, without a default partition', () => {
    const single = [twoPartitions[0]]
    const detach = (version: number, rows: (string | null)[][], extra = false) => {
      const { draft, context } = load(version, rows)
      const options: PgTableOptions = {
        ...context.original!,
        existingPartitions: context.original!.existingPartitions.map((p, i) => ({
          ...p,
          detach: i === 0,
          concurrently: i === 0
        })),
        comment: extra ? 'x' : ''
      }
      const statements = script(draft, options, context)
      return { statements, problem: pgTableOptionProblem(draft, options, context, statements) }
    }
    const ok = detach(170002, single)
    expect(ok.statements).toEqual([
      'ALTER TABLE public.events DETACH PARTITION public.events_2024 CONCURRENTLY'
    ])
    expect(ok.problem).toBeNull()
    expect(detach(130015, single).problem).toMatch(
      /PostgreSQL 13 can't detach partitions concurrently/
    )
    expect(detach(170002, single, true).problem).toMatch(/can't run in a transaction/)
    expect(detach(170002, twoPartitions).problem).toMatch(/default partition/)
  })
})

describe('other dialects', () => {
  it('have no exclusions in their extras', () => {
    const extras = parseExtras('tsql', {}, bookingsTable)
    expect(extras.exclusions).toEqual([])
  })
})
