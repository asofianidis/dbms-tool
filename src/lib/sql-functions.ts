import type { Dialect } from './engines'
import type { ServerVersion } from './mariadb'
import { MARIADB_FUNCTIONS } from './sql-functions-mariadb'
import { PG_EXTENSION_FUNCTIONS } from './sql-functions-pg-extensions'
import { POSTGRES_FUNCTIONS } from './sql-functions-postgres'

/** A built-in function, for completion and the signature tooltip. */
export interface SqlFunction {
  name: string
  /** Parameter list as shown, e.g. `value, fallback, …` */
  params: string[]
  returns?: string
  description: string
  /** Dialects that have it; all when absent */
  dialects?: Dialect[]
  /** Only on MariaDB servers (of the MySQL dialect) */
  onlyMariaDb?: boolean
  /** Not on MariaDB servers: MySQL has it, MariaDB lacks it or takes other arguments */
  notMariaDb?: boolean
  /** The MariaDB version that added it */
  minMariaDb?: [major: number, minor: number]
  /** The PostgreSQL major version that added it */
  minPostgres?: number
  /** Inserted instead of `name()`, with `${field}` placeholders */
  snippet?: string
  /** Only when this PostgreSQL extension is installed, e.g. `vector`, `postgis` */
  extension?: string
}

const PG: Dialect[] = ['postgres']
const MY: Dialect[] = ['mysql']
const MS: Dialect[] = ['tsql']
const LITE: Dialect[] = ['sqlite']

const FUNCTIONS: SqlFunction[] = [
  // Aggregates
  {
    name: 'count',
    params: ['expression'],
    returns: 'bigint',
    description: 'Rows, or non-null values of the expression'
  },
  { name: 'sum', params: ['expression'], description: 'Sum of non-null values' },
  { name: 'avg', params: ['expression'], description: 'Average of non-null values' },
  { name: 'min', params: ['expression'], description: 'Smallest value' },
  { name: 'max', params: ['expression'], description: 'Largest value' },
  {
    name: 'string_agg',
    params: ['expression', 'delimiter'],
    returns: 'text',
    description: 'Values joined with a delimiter',
    dialects: [...PG, ...MS]
  },
  {
    name: 'array_agg',
    params: ['expression'],
    returns: 'array',
    description: 'Values collected into an array',
    dialects: PG
  },
  {
    name: 'json_agg',
    params: ['expression'],
    returns: 'json',
    description: 'Values collected into a JSON array',
    dialects: PG
  },
  {
    name: 'jsonb_agg',
    params: ['expression'],
    returns: 'jsonb',
    description: 'Values collected into a JSONB array',
    dialects: PG
  },
  {
    name: 'group_concat',
    params: ['expression', 'separator'],
    returns: 'text',
    description: 'Values joined into one string',
    dialects: [...MY, ...LITE]
  },
  {
    name: 'stddev',
    params: ['expression'],
    description: 'Sample standard deviation',
    dialects: [...PG, ...MY]
  },
  { name: 'stdev', params: ['expression'], description: 'Sample standard deviation', dialects: MS },
  {
    name: 'bool_and',
    params: ['expression'],
    returns: 'boolean',
    description: 'True when every value is true',
    dialects: PG
  },
  {
    name: 'bool_or',
    params: ['expression'],
    returns: 'boolean',
    description: 'True when any value is true',
    dialects: PG
  },
  // Window
  {
    name: 'row_number',
    params: [],
    returns: 'bigint',
    description: 'Row number within the window partition (needs OVER)'
  },
  { name: 'rank', params: [], returns: 'bigint', description: 'Rank with gaps (needs OVER)' },
  {
    name: 'dense_rank',
    params: [],
    returns: 'bigint',
    description: 'Rank without gaps (needs OVER)'
  },
  {
    name: 'lag',
    params: ['expression', 'offset', 'default'],
    description: 'Value from an earlier row in the window'
  },
  {
    name: 'lead',
    params: ['expression', 'offset', 'default'],
    description: 'Value from a later row in the window'
  },
  { name: 'first_value', params: ['expression'], description: 'First value in the window frame' },
  { name: 'last_value', params: ['expression'], description: 'Last value in the window frame' },
  {
    name: 'ntile',
    params: ['buckets'],
    returns: 'integer',
    description: 'Bucket number from 1 to n'
  },
  // Null handling and conditionals
  { name: 'coalesce', params: ['value', 'fallback', '…'], description: 'First non-null argument' },
  {
    name: 'nullif',
    params: ['value', 'equals'],
    description: 'NULL when both are equal, else the first'
  },
  {
    name: 'greatest',
    params: ['value', 'value', '…'],
    description: 'Largest argument',
    dialects: [...PG, ...MY, ...MS]
  },
  {
    name: 'least',
    params: ['value', 'value', '…'],
    description: 'Smallest argument',
    dialects: [...PG, ...MY, ...MS]
  },
  {
    name: 'isnull',
    params: ['value', 'replacement'],
    description: 'Replacement when the value is NULL',
    dialects: MS
  },
  {
    name: 'ifnull',
    params: ['value', 'replacement'],
    description: 'Replacement when the value is NULL',
    dialects: [...MY, ...LITE]
  },
  {
    name: 'iif',
    params: ['condition', 'then', 'else'],
    description: 'One of two values by a condition',
    dialects: [...MS, ...LITE]
  },
  {
    name: 'if',
    params: ['condition', 'then', 'else'],
    description: 'One of two values by a condition',
    dialects: MY
  },
  // Strings
  {
    name: 'length',
    params: ['string'],
    returns: 'integer',
    description: 'Number of characters',
    dialects: [...PG, ...MY, ...LITE]
  },
  {
    name: 'len',
    params: ['string'],
    returns: 'int',
    description: 'Characters, ignoring trailing spaces',
    dialects: MS
  },
  {
    name: 'char_length',
    params: ['string'],
    returns: 'integer',
    description: 'Number of characters',
    dialects: [...PG, ...MY]
  },
  { name: 'lower', params: ['string'], returns: 'text', description: 'Lower case' },
  { name: 'upper', params: ['string'], returns: 'text', description: 'Upper case' },
  {
    name: 'trim',
    params: ['string'],
    returns: 'text',
    description: 'Removes leading and trailing spaces'
  },
  { name: 'ltrim', params: ['string'], returns: 'text', description: 'Removes leading spaces' },
  { name: 'rtrim', params: ['string'], returns: 'text', description: 'Removes trailing spaces' },
  {
    name: 'substring',
    params: ['string', 'start', 'length'],
    returns: 'text',
    description: 'Part of a string (1-based start)',
    dialects: [...PG, ...MY, ...MS]
  },
  {
    name: 'substr',
    params: ['string', 'start', 'length'],
    returns: 'text',
    description: 'Part of a string (1-based start)',
    dialects: [...PG, ...MY, ...LITE]
  },
  {
    name: 'replace',
    params: ['string', 'from', 'to'],
    returns: 'text',
    description: 'Replaces every occurrence'
  },
  {
    name: 'concat',
    params: ['value', 'value', '…'],
    returns: 'text',
    description: 'Joins values; NULLs count as empty (not in MySQL)',
    dialects: [...PG, ...MY, ...MS]
  },
  {
    name: 'concat_ws',
    params: ['separator', 'value', '…'],
    returns: 'text',
    description: 'Joins values with a separator, skipping NULLs',
    dialects: [...PG, ...MY, ...MS]
  },
  {
    name: 'left',
    params: ['string', 'n'],
    returns: 'text',
    description: 'First n characters',
    dialects: [...PG, ...MY, ...MS]
  },
  {
    name: 'right',
    params: ['string', 'n'],
    returns: 'text',
    description: 'Last n characters',
    dialects: [...PG, ...MY, ...MS]
  },
  {
    name: 'position',
    params: ['substring IN string'],
    returns: 'integer',
    description: '1-based position of a substring, 0 if absent',
    dialects: [...PG, ...MY]
  },
  {
    name: 'strpos',
    params: ['string', 'substring'],
    returns: 'integer',
    description: '1-based position of a substring, 0 if absent',
    dialects: PG
  },
  {
    name: 'charindex',
    params: ['substring', 'string', 'start'],
    returns: 'int',
    description: '1-based position of a substring, 0 if absent',
    dialects: MS
  },
  {
    name: 'instr',
    params: ['string', 'substring'],
    returns: 'integer',
    description: '1-based position of a substring, 0 if absent',
    dialects: [...MY, ...LITE]
  },
  {
    name: 'split_part',
    params: ['string', 'delimiter', 'n'],
    returns: 'text',
    description: 'The nth field of a delimited string',
    dialects: PG
  },
  {
    name: 'regexp_replace',
    params: ['string', 'pattern', 'replacement', 'flags'],
    returns: 'text',
    description: 'Replaces regular expression matches',
    dialects: PG
  },
  {
    name: 'regexp_replace',
    params: ['string', 'pattern', 'replacement', 'position', 'occurrence', 'match_type'],
    returns: 'text',
    description: 'Replaces regular expression matches',
    dialects: MY,
    notMariaDb: true
  },
  {
    name: 'lpad',
    params: ['string', 'length', 'fill'],
    returns: 'text',
    description: 'Pads on the left to a length',
    dialects: [...PG, ...MY]
  },
  {
    name: 'rpad',
    params: ['string', 'length', 'fill'],
    returns: 'text',
    description: 'Pads on the right to a length',
    dialects: [...PG, ...MY]
  },
  {
    name: 'format',
    params: ['format', 'value', '…'],
    returns: 'text',
    description: 'printf-style formatting (%s, %I, %L)',
    dialects: PG
  },
  // Numbers
  { name: 'abs', params: ['number'], description: 'Absolute value' },
  { name: 'round', params: ['number', 'decimals'], description: 'Rounds to a number of decimals' },
  {
    name: 'ceiling',
    params: ['number'],
    description: 'Smallest integer not less than the number',
    dialects: [...PG, ...MY, ...MS]
  },
  {
    name: 'floor',
    params: ['number'],
    description: 'Largest integer not greater than the number',
    dialects: [...PG, ...MY, ...MS]
  },
  {
    name: 'mod',
    params: ['dividend', 'divisor'],
    description: 'Remainder',
    dialects: [...PG, ...MY]
  },
  {
    name: 'power',
    params: ['base', 'exponent'],
    description: 'Base raised to the exponent',
    dialects: [...PG, ...MY, ...MS]
  },
  {
    name: 'random',
    params: [],
    returns: 'double',
    description: 'Random value in [0, 1)',
    dialects: PG
  },
  {
    name: 'rand',
    params: ['seed'],
    returns: 'float',
    description: 'Random value in [0, 1)',
    dialects: [...MY, ...MS]
  },
  // Dates
  {
    name: 'now',
    params: [],
    returns: 'timestamptz',
    description: 'Start of the current transaction',
    dialects: [...PG, ...MY]
  },
  {
    name: 'current_date',
    params: [],
    returns: 'date',
    description: 'Today',
    dialects: [...PG, ...MY, ...LITE]
  },
  {
    name: 'date_trunc',
    params: ["'unit'", 'timestamp'],
    returns: 'timestamp',
    description: "Truncates to 'day', 'month', 'hour'…",
    dialects: PG
  },
  {
    name: 'date_part',
    params: ["'field'", 'timestamp'],
    returns: 'double',
    description: "A field such as 'year' or 'dow'",
    dialects: PG
  },
  {
    name: 'extract',
    params: ['field FROM timestamp'],
    description: 'A field such as YEAR or EPOCH',
    dialects: [...PG, ...MY]
  },
  {
    name: 'age',
    params: ['timestamp', 'timestamp'],
    returns: 'interval',
    description: 'Interval between timestamps',
    dialects: PG
  },
  {
    name: 'to_char',
    params: ['value', 'format'],
    returns: 'text',
    description: "Formats a date or number ('YYYY-MM-DD')",
    dialects: PG
  },
  {
    name: 'to_date',
    params: ['text', 'format'],
    returns: 'date',
    description: 'Parses a date',
    dialects: PG
  },
  {
    name: 'to_timestamp',
    params: ['text', 'format'],
    returns: 'timestamptz',
    description: 'Parses a timestamp, or converts epoch seconds',
    dialects: PG
  },
  {
    name: 'make_date',
    params: ['year', 'month', 'day'],
    returns: 'date',
    description: 'A date from parts',
    dialects: PG
  },
  {
    name: 'getdate',
    params: [],
    returns: 'datetime',
    description: 'Current date and time',
    dialects: MS
  },
  {
    name: 'sysdatetimeoffset',
    params: [],
    returns: 'datetimeoffset',
    description: 'Current time with the offset',
    dialects: MS
  },
  {
    name: 'dateadd',
    params: ['datepart', 'number', 'date'],
    returns: 'datetime',
    description: 'Adds an interval',
    dialects: MS
  },
  {
    name: 'datediff',
    params: ['datepart', 'start', 'end'],
    returns: 'int',
    description: 'Boundaries crossed between two dates',
    dialects: MS
  },
  {
    name: 'datepart',
    params: ['datepart', 'date'],
    returns: 'int',
    description: 'A part such as year or weekday',
    dialects: MS
  },
  {
    name: 'eomonth',
    params: ['date', 'months_to_add'],
    returns: 'date',
    description: 'Last day of the month',
    dialects: MS
  },
  {
    name: 'date_add',
    params: ['date', 'INTERVAL n unit'],
    returns: 'datetime',
    description: 'Adds an interval',
    dialects: MY
  },
  {
    name: 'date_format',
    params: ['date', 'format'],
    returns: 'text',
    description: "Formats a date ('%Y-%m-%d')",
    dialects: MY
  },
  {
    name: 'timestampdiff',
    params: ['unit', 'start', 'end'],
    returns: 'bigint',
    description: 'Difference in whole units',
    dialects: MY
  },
  {
    name: 'strftime',
    params: ['format', 'time', 'modifier', '…'],
    returns: 'text',
    description: "Formats a time ('%Y-%m-%d')",
    dialects: LITE
  },
  {
    name: 'datetime',
    params: ['time', 'modifier', '…'],
    returns: 'text',
    description: "'YYYY-MM-DD HH:MM:SS' after modifiers",
    dialects: LITE
  },
  // Conversion
  { name: 'cast', params: ['value AS type'], description: 'Converts to a type' },
  {
    name: 'convert',
    params: ['type', 'value', 'style'],
    description: 'Converts to a type, with a style for dates',
    dialects: MS
  },
  {
    name: 'try_cast',
    params: ['value AS type'],
    description: 'Converts, or NULL when it fails',
    dialects: MS
  },
  {
    name: 'format',
    params: ['value', 'format', 'culture'],
    returns: 'nvarchar',
    description: '.NET-style formatting',
    dialects: MS
  },
  // JSON
  {
    name: 'jsonb_build_object',
    params: ['key', 'value', '…'],
    returns: 'jsonb',
    description: 'A JSONB object from key/value pairs',
    dialects: PG
  },
  {
    name: 'json_build_object',
    params: ['key', 'value', '…'],
    returns: 'json',
    description: 'A JSON object from key/value pairs',
    dialects: PG
  },
  {
    name: 'jsonb_extract_path_text',
    params: ['json', 'key', '…'],
    returns: 'text',
    description: 'Text at a path',
    dialects: PG
  },
  {
    name: 'jsonb_array_elements',
    params: ['json'],
    returns: 'setof jsonb',
    description: 'One row per array element',
    dialects: PG
  },
  {
    name: 'json_extract',
    params: ['json', "'$.path'"],
    description: 'Value at a JSON path',
    dialects: [...MY, ...LITE]
  },
  {
    name: 'json_value',
    params: ['json', "'$.path'"],
    returns: 'nvarchar',
    description: 'Scalar at a JSON path',
    dialects: MS
  },
  {
    name: 'json_query',
    params: ['json', "'$.path'"],
    returns: 'nvarchar',
    description: 'Object or array at a JSON path',
    dialects: MS
  },
  {
    name: 'json_object',
    params: ['key', 'value', '…'],
    returns: 'json',
    description: 'A JSON object from key/value pairs',
    dialects: [...MY, ...LITE]
  },
  // Arrays and sets (PostgreSQL)
  {
    name: 'unnest',
    params: ['array'],
    returns: 'setof',
    description: 'One row per array element',
    dialects: PG
  },
  {
    name: 'generate_series',
    params: ['start', 'stop', 'step'],
    returns: 'setof',
    description: 'Rows from start to stop',
    dialects: PG
  },
  {
    name: 'array_length',
    params: ['array', 'dimension'],
    returns: 'integer',
    description: 'Length of an array dimension',
    dialects: PG
  },
  {
    name: 'gen_random_uuid',
    params: [],
    returns: 'uuid',
    description: 'A random UUID',
    dialects: PG
  },
  {
    name: 'newid',
    params: [],
    returns: 'uniqueidentifier',
    description: 'A random GUID',
    dialects: MS
  },
  { name: 'uuid', params: [], returns: 'text', description: 'A UUID', dialects: MY }
]

/**
 * The built-in functions of a dialect, one per name. `mariaDb` is the server's version when a
 * MySQL-dialect connection is MariaDB; its own functions (and its variants of shared ones,
 * listed first) then replace the MySQL-only ones. `postgres` is a PostgreSQL server's major
 * version; functions it doesn't have yet are left out (all are offered when it's unknown).
 */
export function functionsFor(
  dialect: Dialect,
  mariaDb?: ServerVersion | null,
  postgres?: number | null,
  /** PostgreSQL extensions installed in the database, whose functions then complete too */
  pgExtensions?: string[]
): SqlFunction[] {
  const seen = new Set<string>()
  const maria = dialect === 'mysql' ? mariaDb : null
  return [
    ...MARIADB_FUNCTIONS,
    ...POSTGRES_FUNCTIONS,
    ...FUNCTIONS,
    ...PG_EXTENSION_FUNCTIONS
  ].filter((f) => {
    if (f.dialects && !f.dialects.includes(dialect)) return false
    if (f.extension && !pgExtensions?.includes(f.extension)) return false
    if (maria ? f.notMariaDb : f.onlyMariaDb) return false
    if (maria && f.minMariaDb) {
      const [major, minor] = f.minMariaDb
      if (maria[0] < major || (maria[0] === major && maria[1] < minor)) return false
    }
    if (f.minPostgres && postgres != null && postgres < f.minPostgres) return false
    if (seen.has(f.name)) return false
    seen.add(f.name)
    return true
  })
}

export function signature(f: SqlFunction): string {
  return `${f.name}(${f.params.join(', ')})${f.returns ? ` → ${f.returns}` : ''}`
}
