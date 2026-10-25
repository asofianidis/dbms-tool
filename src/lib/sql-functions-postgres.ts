import type { Dialect } from './engines'
import type { SqlFunction } from './sql-functions'

/*
 * PostgreSQL functions beyond the shared catalog: SQL/JSON (16+ constructors,
 * 17+ queries and JSON_TABLE), jsonpath, JSON processing, arrays, regular
 * expressions, ordered-set aggregates and common system functions. Versions are
 * the major release that added each one; without one it's in 13 and later.
 */

const PG: Dialect[] = ['postgres']

const pg = (f: Omit<SqlFunction, 'dialects'>): SqlFunction => ({ ...f, dialects: PG })

export const POSTGRES_FUNCTIONS: SqlFunction[] = [
  // SQL/JSON constructors and queries
  pg({
    name: 'json_array',
    params: ['value', '…'],
    returns: 'json',
    description: 'A JSON array of the values (SQL/JSON); add RETURNING jsonb for jsonb',
    minPostgres: 16
  }),
  pg({
    name: 'json_object',
    params: ['key VALUE value', '…'],
    returns: 'json',
    description: 'A JSON object from key VALUE value pairs (SQL/JSON)',
    minPostgres: 16,
    snippet: "json_object('${key}' VALUE ${value})"
  }),
  pg({
    name: 'json_arrayagg',
    params: ['expression'],
    returns: 'json',
    description: 'Values collected into a JSON array (SQL/JSON aggregate)',
    minPostgres: 16
  }),
  pg({
    name: 'json_objectagg',
    params: ['key VALUE value'],
    returns: 'json',
    description: 'Key/value pairs collected into a JSON object (SQL/JSON aggregate)',
    minPostgres: 16,
    snippet: 'json_objectagg(${key} VALUE ${value})'
  }),
  pg({
    name: 'json_scalar',
    params: ['value'],
    returns: 'json',
    description: 'A JSON scalar from an SQL value',
    minPostgres: 17
  }),
  pg({
    name: 'json_serialize',
    params: ['json'],
    returns: 'text',
    description: 'JSON as text or bytea (add RETURNING)',
    minPostgres: 17
  }),
  pg({
    name: 'json_query',
    params: ['json', 'path'],
    returns: 'jsonb',
    description:
      'The JSON the path selects; WITH WRAPPER wraps several items in an array (SQL/JSON)',
    minPostgres: 17,
    snippet: "json_query(${json}, '${$.path}')"
  }),
  pg({
    name: 'json_value',
    params: ['json', 'path'],
    returns: 'text',
    description: 'The scalar the path selects, as text or the RETURNING type (SQL/JSON)',
    minPostgres: 17,
    snippet: "json_value(${json}, '${$.path}')"
  }),
  pg({
    name: 'json_exists',
    params: ['json', 'path'],
    returns: 'boolean',
    description: 'Whether the path selects any item (SQL/JSON)',
    minPostgres: 17,
    snippet: "json_exists(${json}, '${$.path}')"
  }),
  pg({
    name: 'json_table',
    params: ['json', 'path COLUMNS (…)'],
    description: 'Rows and columns from JSON, for FROM (SQL/JSON)',
    minPostgres: 17,
    snippet:
      "json_table(${json}, '${$[*]}' COLUMNS (${id} int PATH '$.${id}', ${name} text PATH '$.${name}')) AS ${jt}"
  }),
  // jsonpath
  pg({
    name: 'jsonb_path_query',
    params: ['target', 'path', 'vars', 'silent'],
    returns: 'setof jsonb',
    description: 'Every item the jsonpath selects, one row each',
    snippet: "jsonb_path_query(${target}, '${$.path}')"
  }),
  pg({
    name: 'jsonb_path_query_array',
    params: ['target', 'path', 'vars', 'silent'],
    returns: 'jsonb',
    description: 'Every item the jsonpath selects, as a JSON array',
    snippet: "jsonb_path_query_array(${target}, '${$.path}')"
  }),
  pg({
    name: 'jsonb_path_query_first',
    params: ['target', 'path', 'vars', 'silent'],
    returns: 'jsonb',
    description: 'The first item the jsonpath selects',
    snippet: "jsonb_path_query_first(${target}, '${$.path}')"
  }),
  pg({
    name: 'jsonb_path_exists',
    params: ['target', 'path', 'vars', 'silent'],
    returns: 'boolean',
    description: 'Whether the jsonpath selects any item (the @? operator)',
    snippet: "jsonb_path_exists(${target}, '${$.path}')"
  }),
  pg({
    name: 'jsonb_path_match',
    params: ['target', 'path', 'vars', 'silent'],
    returns: 'boolean',
    description: 'The result of a jsonpath predicate (the @@ operator)',
    snippet: "jsonb_path_match(${target}, '${$.value > 0}')"
  }),
  // JSON processing
  pg({
    name: 'jsonb_set',
    params: ['target', 'path', 'new_value', 'create_if_missing'],
    returns: 'jsonb',
    description: "Replaces (or adds) the value at a path, e.g. '{a,0}'"
  }),
  pg({
    name: 'jsonb_insert',
    params: ['target', 'path', 'new_value', 'insert_after'],
    returns: 'jsonb',
    description: 'Inserts a value at a path'
  }),
  pg({
    name: 'jsonb_strip_nulls',
    params: ['jsonb'],
    returns: 'jsonb',
    description: 'Removes object fields that are null, recursively'
  }),
  pg({
    name: 'jsonb_pretty',
    params: ['jsonb'],
    returns: 'text',
    description: 'Indented JSON text'
  }),
  pg({
    name: 'jsonb_typeof',
    params: ['jsonb'],
    returns: 'text',
    description: 'object, array, string, number, boolean or null'
  }),
  pg({
    name: 'jsonb_each',
    params: ['jsonb'],
    returns: 'setof (key, value)',
    description: 'The fields of a JSON object, one row each'
  }),
  pg({
    name: 'jsonb_each_text',
    params: ['jsonb'],
    returns: 'setof (key, value text)',
    description: 'The fields of a JSON object as text, one row each'
  }),
  pg({
    name: 'jsonb_object_keys',
    params: ['jsonb'],
    returns: 'setof text',
    description: 'The keys of a JSON object'
  }),
  pg({
    name: 'jsonb_array_length',
    params: ['jsonb'],
    returns: 'integer',
    description: 'Elements in a JSON array'
  }),
  pg({
    name: 'jsonb_array_elements_text',
    params: ['jsonb'],
    returns: 'setof text',
    description: 'The elements of a JSON array as text, one row each'
  }),
  pg({
    name: 'jsonb_to_recordset',
    params: ['jsonb'],
    returns: 'setof record',
    description: 'Rows from a JSON array of objects; give the columns with AS',
    snippet: 'jsonb_to_recordset(${json}) AS ${x}(${id} int, ${name} text)'
  }),
  pg({
    name: 'jsonb_object_agg',
    params: ['key', 'value'],
    returns: 'jsonb',
    description: 'Key/value pairs collected into a JSONB object'
  }),
  pg({
    name: 'to_jsonb',
    params: ['value'],
    returns: 'jsonb',
    description: 'Any value as JSONB'
  }),
  pg({
    name: 'row_to_json',
    params: ['record'],
    returns: 'json',
    description: 'A row as a JSON object'
  }),
  // Arrays
  pg({
    name: 'array_to_string',
    params: ['array', 'delimiter', 'null_string'],
    returns: 'text',
    description: 'Array elements joined with a delimiter'
  }),
  pg({
    name: 'string_to_array',
    params: ['string', 'delimiter', 'null_string'],
    returns: 'text[]',
    description: 'A string split into an array'
  }),
  pg({
    name: 'array_append',
    params: ['array', 'element'],
    returns: 'array',
    description: 'The array with an element added at the end'
  }),
  pg({
    name: 'array_remove',
    params: ['array', 'element'],
    returns: 'array',
    description: 'The array without elements equal to the value'
  }),
  pg({
    name: 'array_position',
    params: ['array', 'element'],
    returns: 'integer',
    description: 'Subscript of the first occurrence, or NULL'
  }),
  pg({
    name: 'cardinality',
    params: ['array'],
    returns: 'integer',
    description: 'Total number of elements in the array'
  }),
  pg({
    name: 'trim_array',
    params: ['array', 'n'],
    returns: 'array',
    description: 'The array without its last n elements',
    minPostgres: 14
  }),
  pg({
    name: 'array_shuffle',
    params: ['array'],
    returns: 'array',
    description: 'The array in random order',
    minPostgres: 16
  }),
  pg({
    name: 'array_sample',
    params: ['array', 'n'],
    returns: 'array',
    description: 'n randomly chosen elements',
    minPostgres: 16
  }),
  // Strings and regular expressions
  pg({
    name: 'regexp_matches',
    params: ['string', 'pattern', 'flags'],
    returns: 'setof text[]',
    description: "Captured groups of each match; 'g' for every match"
  }),
  pg({
    name: 'regexp_match',
    params: ['string', 'pattern', 'flags'],
    returns: 'text[]',
    description: 'Captured groups of the first match'
  }),
  pg({
    name: 'regexp_split_to_table',
    params: ['string', 'pattern', 'flags'],
    returns: 'setof text',
    description: 'A string split on a regular expression, one row each'
  }),
  pg({
    name: 'regexp_like',
    params: ['string', 'pattern', 'flags'],
    returns: 'boolean',
    description: 'Whether the regular expression matches',
    minPostgres: 15
  }),
  pg({
    name: 'regexp_count',
    params: ['string', 'pattern', 'start', 'flags'],
    returns: 'integer',
    description: 'Number of matches',
    minPostgres: 15
  }),
  pg({
    name: 'regexp_substr',
    params: ['string', 'pattern', 'start', 'n', 'flags', 'subexpr'],
    returns: 'text',
    description: 'The text of the nth match',
    minPostgres: 15
  }),
  pg({
    name: 'starts_with',
    params: ['string', 'prefix'],
    returns: 'boolean',
    description: 'Whether the string starts with the prefix'
  }),
  pg({
    name: 'initcap',
    params: ['string'],
    returns: 'text',
    description: 'Each word capitalized'
  }),
  pg({ name: 'md5', params: ['string'], returns: 'text', description: 'MD5 hash as hex' }),
  pg({
    name: 'quote_ident',
    params: ['string'],
    returns: 'text',
    description: 'Quoted as an identifier where needed'
  }),
  pg({
    name: 'quote_literal',
    params: ['value'],
    returns: 'text',
    description: 'Quoted as a string literal'
  }),
  // Dates and times
  pg({
    name: 'date_bin',
    params: ['stride', 'source', 'origin'],
    returns: 'timestamp',
    description: 'The timestamp rounded down to the start of its stride-sized bin',
    minPostgres: 14,
    snippet: "date_bin('${15 minutes}', ${ts}, TIMESTAMP '${2001-01-01}')"
  }),
  pg({
    name: 'make_interval',
    params: ['years', 'months', 'weeks', 'days', 'hours', 'mins', 'secs'],
    returns: 'interval',
    description: 'An interval from named parts, e.g. make_interval(days => 10)'
  }),
  pg({
    name: 'clock_timestamp',
    params: [],
    returns: 'timestamptz',
    description: 'The current time, changing during a statement (now() is fixed per transaction)'
  }),
  // Ordered-set and other aggregates
  pg({
    name: 'percentile_cont',
    params: ['fraction'],
    returns: 'double precision',
    description: 'Interpolated percentile: percentile_cont(0.5) WITHIN GROUP (ORDER BY x)',
    snippet: 'percentile_cont(${0.5}) WITHIN GROUP (ORDER BY ${expression})'
  }),
  pg({
    name: 'percentile_disc',
    params: ['fraction'],
    description: 'First value at or past the percentile, within ORDER BY',
    snippet: 'percentile_disc(${0.5}) WITHIN GROUP (ORDER BY ${expression})'
  }),
  pg({
    name: 'mode',
    params: [],
    description: 'Most frequent value: mode() WITHIN GROUP (ORDER BY x)',
    snippet: 'mode() WITHIN GROUP (ORDER BY ${expression})'
  }),
  pg({
    name: 'any_value',
    params: ['expression'],
    description: 'Any one of the non-null values',
    minPostgres: 16
  }),
  pg({
    name: 'range_agg',
    params: ['range'],
    returns: 'multirange',
    description: 'The union of the ranges, as a multirange',
    minPostgres: 14
  }),
  // Sequences and system
  pg({
    name: 'nextval',
    params: ['sequence'],
    returns: 'bigint',
    description: "Advances the sequence and returns its value, e.g. nextval('seq')"
  }),
  pg({
    name: 'currval',
    params: ['sequence'],
    returns: 'bigint',
    description: 'The value nextval last returned for the sequence in this session'
  }),
  pg({
    name: 'setval',
    params: ['sequence', 'value', 'is_called'],
    returns: 'bigint',
    description: 'Sets the sequence value'
  }),
  pg({
    name: 'pg_typeof',
    params: ['value'],
    returns: 'regtype',
    description: 'The data type of the value'
  }),
  pg({
    name: 'current_setting',
    params: ['setting', 'missing_ok'],
    returns: 'text',
    description: 'The value of a configuration setting'
  }),
  pg({
    name: 'set_config',
    params: ['setting', 'value', 'is_local'],
    returns: 'text',
    description: 'Sets a configuration setting; is_local limits it to the transaction'
  }),
  pg({
    name: 'pg_size_pretty',
    params: ['bytes'],
    returns: 'text',
    description: 'A byte count with units, e.g. 12 MB'
  }),
  pg({
    name: 'pg_total_relation_size',
    params: ['regclass'],
    returns: 'bigint',
    description: 'Disk space of a table with its indexes and TOAST'
  }),
  pg({
    name: 'pg_current_xact_id',
    params: [],
    returns: 'xid8',
    description: 'The current transaction ID, assigning one if needed'
  }),
  pg({
    name: 'num_nulls',
    params: ['value', '…'],
    returns: 'integer',
    description: 'Number of NULL arguments'
  }),
  pg({
    name: 'merge_action',
    params: [],
    returns: 'text',
    description: 'INSERT, UPDATE or DELETE: the action of a MERGE row, in RETURNING',
    minPostgres: 17
  })
]
