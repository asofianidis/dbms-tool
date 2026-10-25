import { AlertTriangle, Plus, X } from 'lucide-react'
import { authLoginProblem, authPlugin, type AuthPluginChoice } from '@/lib/authPlugins'
import type { PrincipalDraft } from '@/lib/principals'
import { Button, Field, Select } from '@/components/ui'

/**
 * A MySQL or MariaDB account's authentication plugin, and on MariaDB 10.4+ the methods
 * tried after it (IDENTIFIED VIA a OR b).
 */
export function AuthPluginFields({
  draft,
  set,
  choices,
  mariadb,
  multiple
}: {
  draft: PrincipalDraft
  set: <K extends keyof PrincipalDraft>(key: K, value: PrincipalDraft[K]) => void
  choices: AuthPluginChoice[]
  mariadb: boolean
  /** MariaDB 10.4+: more than one method */
  multiple: boolean
}): React.JSX.Element {
  const methods = draft.plugins
  // The server default only means something before the account has a plugin of its own
  const canDefault = !draft.original?.plugins.length
  const unused = choices.filter((c) => c.available && !methods.includes(c.plugin.name))
  const problem = authLoginProblem(methods, mariadb)

  const options = (current: string): React.JSX.Element[] =>
    choices
      .filter((c) => c.plugin.name === current || !methods.includes(c.plugin.name))
      .map(({ plugin, available, unavailable }) => (
        <option key={plugin.name} value={plugin.name} disabled={!available}>
          {available ? plugin.name : `${plugin.name} (${unavailable})`}
        </option>
      ))
  const hintOf = (name: string | undefined): string | undefined =>
    name ? authPlugin(name, mariadb).hint : 'The server picks the plugin for new accounts'

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Authentication" className="w-72" hint={hintOf(methods[0])}>
          <Select
            selectClassName="font-mono text-xs"
            value={methods[0] ?? ''}
            onChange={(e) => {
              const name = e.target.value
              set('plugins', name ? [name, ...methods.slice(1).filter((m) => m !== name)] : [])
            }}
          >
            {canDefault && <option value="">Server default</option>}
            {options(methods[0] ?? '')}
          </Select>
        </Field>
        {methods.slice(1).map((name, i) => (
          <div key={name} className="flex items-end gap-1">
            <Field label="Or" className="w-56" hint={hintOf(name)}>
              <Select
                selectClassName="font-mono text-xs"
                value={name}
                onChange={(e) =>
                  set(
                    'plugins',
                    methods.map((m, j) => (j === i + 1 ? e.target.value : m))
                  )
                }
              >
                {options(name)}
              </Select>
            </Field>
            <Button
              size="icon"
              variant="ghost"
              className="mb-px hover:text-danger"
              title={`Remove ${name}`}
              onClick={() =>
                set(
                  'plugins',
                  methods.filter((_, j) => j !== i + 1)
                )
              }
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        {multiple && methods.length > 0 && unused.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            title="IDENTIFIED VIA … OR …: the server tries the methods in order"
            onClick={() => set('plugins', [...methods, unused[0].plugin.name])}
          >
            <Plus className="size-3.5" /> Or another method
          </Button>
        )}
      </div>
      {problem && (
        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted">
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-warn" />
          <span>{problem}</span>
        </p>
      )}
    </div>
  )
}
