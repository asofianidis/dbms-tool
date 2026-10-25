import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type ConnectionConfig, type ResultSet } from '@/lib/api'
import { errorMessage } from '@/lib/toast'

export interface SqlPanel {
  set: ResultSet | null
  error: string | null
  loading: boolean
  reload: () => void
}

/** Runs `sql` on the connection's metadata session (in `database`, else the default), and again on `reload`. */
export function useSqlPanel(
  connection: ConnectionConfig,
  sql: string | null,
  database = ''
): SqlPanel {
  const [set, setSet] = useState<ResultSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const sqlRef = useRef(sql)
  sqlRef.current = sql
  // Auto-refresh mustn't stack requests behind a slow one; a change while busy runs once after
  const busy = useRef(false)
  const queued = useRef(false)
  const reload = useCallback(async () => {
    if (busy.current) {
      queued.current = true
      return
    }
    busy.current = true
    setLoading(true)
    try {
      do {
        queued.current = false
        const text = sqlRef.current
        if (!text) {
          setSet(null)
          setError(null)
          continue
        }
        try {
          // Listings only; `EXEC sp_babelfish_configure` reads settings, so no production prompt
          const out = await api.execute(connection.id, '__meta', database, text, {
            confirmed: true
          })
          // Results for SQL that has since changed are stale
          if (queued.current) continue
          if (out.error) setError(out.error.message)
          else {
            setSet(out.results[out.results.length - 1] ?? null)
            setError(null)
          }
        } catch (e) {
          if (!queued.current) setError(errorMessage(e))
        }
      } while (queued.current)
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [connection.id, database])
  useEffect(() => {
    void reload()
  }, [reload, sql])
  return { set, error, loading, reload: () => void reload() }
}
