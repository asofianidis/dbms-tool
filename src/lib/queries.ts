import { QueryClient, queryOptions } from '@tanstack/react-query'
import { api } from './api'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      retry: false,
      refetchOnWindowFocus: false
    }
  }
})

export const queries = {
  databases: (id: string) =>
    queryOptions({ queryKey: ['conn', id, 'databases'], queryFn: () => api.databases(id) }),
  schemas: (id: string, database: string) =>
    queryOptions({
      queryKey: ['conn', id, 'schemas', database],
      queryFn: () => api.schemas(id, database)
    }),
  objects: (id: string, database: string, schema: string | null) =>
    queryOptions({
      queryKey: ['conn', id, 'objects', database, schema],
      queryFn: () => api.objects(id, database, schema)
    }),
  table: (id: string, database: string, schema: string | null, name: string) =>
    queryOptions({
      queryKey: ['conn', id, 'table', database, schema, name],
      queryFn: () => api.table(id, database, schema, name)
    }),
  definition: (
    id: string,
    database: string,
    schema: string | null,
    name: string,
    kind: string,
    detail?: string | null
  ) =>
    queryOptions({
      queryKey: ['conn', id, 'definition', database, schema, name, kind, detail ?? null],
      queryFn: () => api.definition(id, database, schema, name, kind, detail)
    }),
  completion: (id: string, database: string) =>
    queryOptions({
      queryKey: ['conn', id, 'completion', database],
      queryFn: () => api.completion(id, database),
      staleTime: 10 * 60_000
    })
}
