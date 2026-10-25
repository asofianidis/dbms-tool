import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import {
  NO_PG_EXTENSIONS,
  parsePgExtensions,
  pgExtensionsSql,
  type PgExtensions
} from './pg-extensions-aware'

/**
 * pgvector / PostGIS in a PostgreSQL database, from `pg_extension` over the
 * metadata session. Neither while loading, when `enabled` is false (other
 * engines) or when the query fails.
 */
export function usePgExtensions(
  connectionId: string,
  database: string | null | undefined,
  enabled: boolean
): PgExtensions {
  const query = useQuery({
    queryKey: ['conn', connectionId, 'pg-extensions', database],
    queryFn: async () => {
      const out = await api.execute(connectionId, '__meta', database ?? '', pgExtensionsSql)
      if (out.error) throw new Error(out.error.message)
      return parsePgExtensions(out.results[0]?.rows ?? [])
    },
    enabled: enabled && !!database,
    staleTime: 60_000,
    retry: false
  })
  return (enabled && query.data) || NO_PG_EXTENSIONS
}
