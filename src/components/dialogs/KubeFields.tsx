import { useQuery } from '@tanstack/react-query'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { FolderOpen } from 'lucide-react'
import { api, type KubeConfig } from '@/lib/api'
import { errorMessage } from '@/lib/toast'
import { Button, Field, Input, Toggle } from '../ui'

export function newKubeConfig(): KubeConfig {
  return { enabled: true, context: '', namespace: '', kubeconfig: '', image: '' }
}

/** The connection dialog's "Kubernetes tunnel pod" section. */
export function KubeFields({
  kube,
  onChange,
  uriMode
}: {
  kube: KubeConfig | null | undefined
  onChange: (kube: KubeConfig) => void
  /** MongoDB or Redis in connection-string mode, which can't be tunnelled */
  uriMode: boolean
}): React.JSX.Element {
  const on = !!kube?.enabled
  const patch = (p: Partial<KubeConfig>): void => onChange({ ...(kube ?? newKubeConfig()), ...p })
  const kubeconfig = kube?.kubeconfig.trim() ?? ''
  const contexts = useQuery({
    queryKey: ['kube-contexts', kubeconfig],
    queryFn: () => api.kubeContexts(kubeconfig),
    enabled: on,
    retry: false,
    staleTime: 60_000
  })

  const browseKubeconfig = async (): Promise<void> => {
    const path = await openDialog({ multiple: false })
    if (typeof path === 'string') patch({ kubeconfig: path })
  }

  return (
    <div className="space-y-3 rounded-lg border border-line bg-raised/40 p-3">
      <Toggle
        checked={on}
        onChange={(enabled) => patch({ enabled })}
        label="Kubernetes tunnel pod"
        description="Reach the database from inside a cluster: a temporary relay pod is started while the connection is open, through kubectl"
      />
      {on && (
        <>
          {uriMode && (
            <p className="text-xs text-danger">
              Tunnel pods need the Host &amp; port form; a connection string can&apos;t be
              tunnelled.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Context"
              hint={
                contexts.error
                  ? errorMessage(contexts.error)
                  : `Empty for the current one${contexts.data?.current ? ` (${contexts.data.current})` : ''}`
              }
            >
              <Input
                value={kube.context}
                onChange={(e) => patch({ context: e.target.value })}
                placeholder={contexts.data?.current ?? 'Current context'}
                list="kube-contexts"
              />
              <datalist id="kube-contexts">
                {contexts.data?.contexts.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field
              label="Namespace"
              hint="Where the pod runs; needs permission to create pods there"
            >
              <Input
                value={kube.namespace}
                onChange={(e) => patch({ namespace: e.target.value })}
                placeholder="The context's namespace"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kubeconfig (optional)">
              <div className="flex gap-2">
                <Input
                  mono
                  value={kube.kubeconfig}
                  onChange={(e) => patch({ kubeconfig: e.target.value })}
                  placeholder="~/.kube/config"
                />
                <Button variant="secondary" onClick={() => void browseKubeconfig()}>
                  <FolderOpen className="size-3.5" />
                </Button>
              </div>
            </Field>
            <Field label="Relay image (optional)" hint="Must have socat on its PATH">
              <Input
                mono
                value={kube.image}
                onChange={(e) => patch({ image: e.target.value })}
                placeholder="alpine/socat (pinned)"
              />
            </Field>
          </div>
          <p className="text-[11px] leading-snug text-faint">
            The database host and port above are resolved inside the cluster. The pod runs as an
            unprivileged user and is deleted when you disconnect or quit; pods left by a crash are
            cleaned up next time and expire after 12 hours.
          </p>
        </>
      )}
    </div>
  )
}
