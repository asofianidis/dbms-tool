import type { SqlFunction } from './sql-functions'

/*
 * Functions MariaDB has and MySQL doesn't, and MariaDB's variants of shared ones.
 * They come before the shared catalog, so a variant here wins over the MySQL entry of
 * the same name. Versions are the MariaDB release that added each one.
 */
const OWN: SqlFunction[] = [
  // Variants of shared functions
  {
    name: 'lag',
    params: ['expression', 'offset'],
    description: 'Value from an earlier row in the window (no default argument in MariaDB)'
  },
  {
    name: 'lead',
    params: ['expression', 'offset'],
    description: 'Value from a later row in the window (no default argument in MariaDB)'
  },
  {
    name: 'regexp_replace',
    params: ['string', 'pattern', 'replacement'],
    returns: 'text',
    description: 'Replaces every regular expression match; flags go in the pattern, e.g. (?i)'
  },
  // Sequences
  {
    name: 'nextval',
    params: ['sequence'],
    returns: 'bigint',
    description: 'Advances the sequence and returns its value (NEXT VALUE FOR)',
    minMariaDb: [10, 3]
  },
  {
    name: 'lastval',
    params: ['sequence'],
    returns: 'bigint',
    description: 'Value this session last took from the sequence (PREVIOUS VALUE FOR)',
    minMariaDb: [10, 3]
  },
  {
    name: 'setval',
    params: ['sequence', 'next_value', 'is_used', 'round'],
    returns: 'bigint',
    description: 'Sets the sequence’s next value; NULL when it would move backwards',
    minMariaDb: [10, 3]
  },
  // JSON
  {
    name: 'json_table',
    params: ['json', "'$path'", 'COLUMNS (…)'],
    returns: 'table',
    description: 'Rows and typed columns from a JSON document, in FROM',
    minMariaDb: [10, 6],
    snippet:
      "json_table(${json}, '${$[*]}' COLUMNS (${name} ${VARCHAR(100)} PATH '${$.name}')) AS ${jt}"
  },
  {
    name: 'json_equals',
    params: ['json', 'json'],
    returns: 'integer',
    description: '1 when two documents are equal after normalizing, NULL on invalid JSON',
    minMariaDb: [10, 7]
  },
  {
    name: 'json_normalize',
    params: ['json'],
    returns: 'json',
    description: 'Canonical form: sorted keys, no spaces, numbers as doubles',
    minMariaDb: [10, 7]
  },
  {
    name: 'json_overlaps',
    params: ['json', 'json'],
    returns: 'integer',
    description: '1 when the documents share a key/value pair or array element',
    minMariaDb: [10, 9]
  },
  {
    name: 'json_schema_valid',
    params: ['schema', 'json'],
    returns: 'integer',
    description: '1 when the document matches the JSON Schema',
    minMariaDb: [11, 1]
  },
  {
    name: 'json_key_value',
    params: ['json', "'$path'"],
    returns: 'json',
    description: 'The object at the path as an array of {"key", "value"} objects',
    minMariaDb: [11, 2]
  },
  {
    name: 'json_array_intersect',
    params: ['array', 'array'],
    returns: 'json',
    description: 'Elements both arrays have',
    minMariaDb: [11, 2]
  },
  {
    name: 'json_object_filter_keys',
    params: ['object', 'keys_array'],
    returns: 'json',
    description: 'The object with only the keys listed in the array',
    minMariaDb: [11, 2]
  },
  {
    name: 'json_object_to_array',
    params: ['object'],
    returns: 'json',
    description: 'The object as an array of [key, value] pairs',
    minMariaDb: [11, 2]
  },
  // Strings
  {
    name: 'natural_sort_key',
    params: ['string'],
    returns: 'text',
    description: 'A key that sorts numbers in the string by value (a2 before a10)',
    minMariaDb: [10, 7]
  },
  {
    name: 'sformat',
    params: ["'format {}'", 'value', '…'],
    returns: 'text',
    description: 'Python/fmt-style formatting: {} and {:.2f} placeholders',
    minMariaDb: [10, 7]
  },
  // UUIDs
  {
    name: 'uuid_v4',
    params: [],
    returns: 'uuid',
    description: 'A random (version 4) UUID',
    minMariaDb: [11, 7]
  },
  {
    name: 'uuid_v7',
    params: [],
    returns: 'uuid',
    description: 'A time-ordered (version 7) UUID',
    minMariaDb: [11, 7]
  },
  // Vectors
  {
    name: 'vec_fromtext',
    params: ["'[1, 2, 3]'"],
    returns: 'vector',
    description: 'A vector from a JSON array of numbers',
    minMariaDb: [11, 7]
  },
  {
    name: 'vec_totext',
    params: ['vector'],
    returns: 'text',
    description: 'A vector as a JSON array',
    minMariaDb: [11, 7]
  },
  {
    name: 'vec_distance_euclidean',
    params: ['vector', 'vector'],
    returns: 'double',
    description: 'Euclidean (L2) distance between vectors',
    minMariaDb: [11, 7]
  },
  {
    name: 'vec_distance_cosine',
    params: ['vector', 'vector'],
    returns: 'double',
    description: 'Cosine distance between vectors',
    minMariaDb: [11, 7]
  },
  {
    name: 'vec_distance',
    params: ['vector', 'vector'],
    returns: 'double',
    description: 'Distance by the metric of the column’s VECTOR INDEX (needs one)',
    minMariaDb: [11, 7]
  }
]

export const MARIADB_FUNCTIONS: SqlFunction[] = OWN.map((f) => ({
  ...f,
  dialects: ['mysql'],
  onlyMariaDb: true
}))
