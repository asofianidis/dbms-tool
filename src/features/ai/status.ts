import { queryOptions } from '@tanstack/react-query'
import { api, type AiProvider } from '@/lib/api'

/**
 * Whether a provider can take requests. Only the local server's depends on
 * its URL, so editing that doesn't re-check (and re-run) the CLIs.
 */
export function aiStatusQuery(provider: AiProvider, baseUrl: string) {
  const url = provider === 'openai-compatible' ? baseUrl : ''
  return queryOptions({
    queryKey: ['ai-status', provider, url],
    queryFn: () => api.aiStatus(provider, url || undefined),
    staleTime: 60_000
  })
}
