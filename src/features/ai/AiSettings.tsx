import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { api, type AiProvider } from '@/lib/api'
import { AI_PROVIDERS, AI_PROVIDER_ORDER } from '@/lib/ai'
import { queryClient } from '@/lib/queries'
import { settingsStore, type Settings } from '@/lib/settings'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { Button, Input, Select, Switch } from '@/components/ui'
import { Row, Section } from '../settings/layout'

export function AiSettings(): React.JSX.Element {
  const settings = settingsStore.use()
  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void =>
    settingsStore.set((s) => ({ ...s, [key]: value }))
  return (
    <Section title="AI assistant">
      <Row
        title="AI assistant"
        description="Off until you turn it on. Ask for queries in plain English, explain queries and plans, and fix errors from the query editor. Pick the provider and model in the assistant panel; set them up here"
      >
        <Switch checked={settings.aiEnabled} onChange={(v) => set('aiEnabled', v)} />
      </Row>
      {settings.aiEnabled && (
        <>
          {AI_PROVIDER_ORDER.map((p) => (
            <ProviderRows key={p} provider={p} baseUrl={settings.aiBaseUrl} />
          ))}
          <Row
            title="Let the assistant read data"
            description={
              settings.aiAllowData
                ? 'The assistant may ask to run read-only queries and sees up to the rows set below. DELETE, DROP, UPDATE and every other write are always refused, and the queries run on a separate read-only session'
                : 'Off: only table, column and key names are sent, never rows. The assistant writes queries but cannot run them'
            }
          >
            <Switch checked={settings.aiAllowData} onChange={(v) => set('aiAllowData', v)} />
          </Row>
          {settings.aiAllowData && (
            <>
              <Row
                title="Ask before each query"
                description="Show each query the assistant wants to run and wait for Run"
              >
                <Switch
                  checked={settings.aiConfirmQueries}
                  onChange={(v) => set('aiConfirmQueries', v)}
                />
              </Row>
              <Row
                title="Rows per query"
                description="The most rows of each result sent to the provider"
              >
                <Select
                  value={String(settings.aiMaxRows)}
                  onChange={(e) => set('aiMaxRows', Number(e.target.value))}
                  className="w-32"
                >
                  {[10, 25, 50, 100, 200, 500].map((n) => (
                    <option key={n} value={n}>
                      {n} rows
                    </option>
                  ))}
                </Select>
              </Row>
            </>
          )}
        </>
      )}
    </Section>
  )
}

/** One provider's setup: its server URL and key where it needs them, and whether it's ready. */
function ProviderRows({
  provider,
  baseUrl
}: {
  provider: AiProvider
  baseUrl: string
}): React.JSX.Element {
  const info = AI_PROVIDERS[provider]
  return (
    <>
      <StatusRow provider={provider} baseUrl={baseUrl} />
      {info.auth === 'local' && (
        <Row
          title="Local server URL"
          description="The OpenAI-compatible API base, e.g. http://localhost:11434/v1 for Ollama or http://localhost:1234/v1 for LM Studio"
        >
          <Input
            mono
            value={baseUrl}
            onChange={(e) => settingsStore.set((s) => ({ ...s, aiBaseUrl: e.target.value }))}
            className="w-72"
          />
        </Row>
      )}
      {info.auth !== 'cli' && <KeyRow provider={provider} />}
    </>
  )
}

function StatusRow({
  provider,
  baseUrl
}: {
  provider: AiProvider
  baseUrl: string
}): React.JSX.Element {
  const status = useQuery({
    queryKey: ['ai-status', provider, baseUrl],
    queryFn: () => api.aiStatus(provider, baseUrl),
    staleTime: 60_000
  })
  const data = status.data
  return (
    <Row
      title={AI_PROVIDERS[provider].label}
      description={
        status.isFetching
          ? 'Checking…'
          : data
            ? [data.detail, data.ready ? null : AI_PROVIDERS[provider].setup, data.path]
                .filter(Boolean)
                .join(' · ')
            : status.error
              ? errorMessage(status.error)
              : AI_PROVIDERS[provider].description
      }
    >
      <div className="flex items-center gap-2">
        {data &&
          !status.isFetching &&
          (data.ready ? (
            <CheckCircle2 className="size-4 text-ok" aria-label="Ready" />
          ) : (
            <XCircle className="size-4 text-danger" aria-label="Not ready" />
          ))}
        <Button size="sm" variant="ghost" onClick={() => void status.refetch()}>
          <RefreshCw className="size-3.5" /> Check
        </Button>
      </div>
    </Row>
  )
}

function KeyRow({ provider }: { provider: AiProvider }): React.JSX.Element {
  const [key, setKey] = useState('')
  const saved = useQuery({
    queryKey: ['ai-key', provider],
    queryFn: () => api.aiKeyStatus(provider)
  })
  const refresh = (): void => {
    void saved.refetch()
    void queryClient.invalidateQueries({ queryKey: ['ai-status', provider] })
  }
  const optional = AI_PROVIDERS[provider].auth === 'local'
  return (
    <Row
      title={provider === 'anthropic' ? 'Anthropic API key' : 'Local server key'}
      description={
        saved.data
          ? 'Saved in the OS credential store'
          : optional
            ? 'Only if the server asks for one. Kept in the OS credential store'
            : 'Kept in the OS credential store, never in settings files'
      }
    >
      {saved.data ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void api.aiKeyDelete(provider).then(refresh).catch(toastError)}
        >
          Remove key
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            type="password"
            mono
            value={key}
            placeholder={provider === 'anthropic' ? 'sk-ant-…' : 'Key'}
            onChange={(e) => setKey(e.target.value)}
            className="w-56"
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={!key.trim()}
            onClick={() =>
              void api
                .aiKeySet(provider, key)
                .then(() => {
                  setKey('')
                  toast('Key saved')
                  refresh()
                })
                .catch(toastError)
            }
          >
            Save
          </Button>
        </div>
      )}
    </Row>
  )
}
