import { useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { LogIn, UserPlus } from 'lucide-react'
import type { CloudProvider } from '@/lib/api'
import { PROVIDERS } from '@/lib/cloud'
import { toast, toastError } from '@/lib/toast'
import { Button, Field, Input, Modal, Spinner } from '@/components/ui'
import { addBrowserAccount, addTokenAccount, selectAccount } from './actions'

/**
 * Adds another account for a provider: a browser sign-in the CLI keeps next to
 * its others (Google Cloud, Azure), or an API token for the other account.
 */
export function AccountDialog({
  provider,
  onClose
}: {
  provider: CloudProvider
  onClose: () => void
}): React.JSX.Element | null {
  const info = PROVIDERS[provider]
  const add = info.addAccount
  const [label, setLabel] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  if (!add) return null

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      if (add.kind === 'browser') {
        const added = await addBrowserAccount(provider)
        if (added) selectAccount(provider, added)
        toast(added ? `Added ${added}` : `Signed in to ${info.label}`)
      } else {
        selectAccount(provider, await addTokenAccount(provider, token, label))
        toast(`Added a ${info.label} account`)
      }
      onClose()
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }
  const ready = add.kind === 'browser' || !!token.trim()

  return (
    <Modal
      width="md"
      title={`Add a ${info.label} account`}
      description={
        add.kind === 'browser'
          ? `Signs in through the ${info.cli} CLI, next to the accounts it already has`
          : `Kept in the OS credential manager and only ever sent to ${info.label}`
      }
      icon={
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-info/15 text-info">
          <UserPlus className="size-4" />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          {add.kind === 'token' && add.url && (
            <Button variant="ghost" className="mr-auto" onClick={() => void openUrl(add.url!)}>
              Create a token
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || busy} onClick={() => void run()}>
            {busy ? <Spinner className="text-current" /> : <LogIn className="size-3.5" />}
            {add.kind === 'browser'
              ? busy
                ? 'Waiting for the browser…'
                : 'Sign in'
              : 'Add account'}
          </Button>
        </>
      }
    >
      {add.kind === 'browser' ? (
        <p className="text-[13px] leading-relaxed text-fg">
          Your browser opens to sign in.{' '}
          {provider === 'gcp'
            ? "gcloud's active account stays as it is; pick the new one from the Account list here."
            : 'Its subscriptions then show in the Subscription list alongside the ones you have.'}
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-fg">{add.hint}</p>
          <Field label="Name">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Shown in the account list; defaults to the account's email"
            />
          </Field>
          <Field label="Token">
            <Input
              mono
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ready) void run()
              }}
              placeholder="API token"
            />
          </Field>
        </div>
      )}
    </Modal>
  )
}
