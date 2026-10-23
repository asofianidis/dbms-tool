import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { FolderOpen } from 'lucide-react'
import type { SshAuth, SshConfig } from '@/lib/api'
import { Button, Field, Input, Segmented, Toggle } from '../ui'

export function newSshConfig(): SshConfig {
  return { enabled: true, host: '', port: 0, user: '', auth: 'agent', keyFile: '', jumpHost: '' }
}

/** The connection dialog's "SSH tunnel" section. */
export function SshFields({
  ssh,
  onChange,
  secret,
  onSecret,
  hasSavedSecret,
  uriMode
}: {
  ssh: SshConfig | null | undefined
  onChange: (ssh: SshConfig) => void
  secret: string
  onSecret: (secret: string) => void
  /** An SSH password or passphrase is already in the credential manager */
  hasSavedSecret: boolean
  /** MongoDB in connection-string mode, which can't be tunnelled */
  uriMode: boolean
}): React.JSX.Element {
  const on = !!ssh?.enabled
  const patch = (p: Partial<SshConfig>): void => onChange({ ...(ssh ?? newSshConfig()), ...p })

  const browseKey = async (): Promise<void> => {
    const path = await openDialog({ multiple: false })
    if (typeof path === 'string') patch({ keyFile: path })
  }

  return (
    <div className="space-y-3 rounded-lg border border-line bg-raised/40 p-3">
      <Toggle
        checked={on}
        onChange={(enabled) => patch({ enabled })}
        label="SSH tunnel"
        description="Reach the database through an SSH server (bastion or jump host) with the system's ssh client"
      />
      {on && (
        <>
          {uriMode && (
            <p className="text-xs text-danger">
              SSH tunnels need the Host &amp; port form; a connection string can&apos;t be
              tunnelled.
            </p>
          )}
          <div className="grid grid-cols-[1fr_6rem_1fr] gap-3">
            <Field label="SSH server" hint="A host name or a Host alias from ~/.ssh/config">
              <Input
                value={ssh.host}
                onChange={(e) => patch({ host: e.target.value })}
                placeholder="bastion.example.com"
              />
            </Field>
            <Field label="Port">
              <Input
                value={ssh.port ? String(ssh.port) : ''}
                onChange={(e) => patch({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })}
                placeholder="22"
                inputMode="numeric"
              />
            </Field>
            <Field label="SSH user">
              <Input
                value={ssh.user}
                onChange={(e) => patch({ user: e.target.value })}
                placeholder="From ~/.ssh/config"
              />
            </Field>
          </div>
          <Field label="SSH authentication">
            <Segmented<SshAuth>
              value={ssh.auth}
              onChange={(auth) => patch({ auth })}
              options={[
                { value: 'agent', label: 'Agent & default keys' },
                { value: 'key', label: 'Key file' },
                { value: 'password', label: 'Password' }
              ]}
            />
          </Field>
          {ssh.auth === 'key' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Private key">
                <div className="flex gap-2">
                  <Input
                    mono
                    value={ssh.keyFile}
                    onChange={(e) => patch({ keyFile: e.target.value })}
                    placeholder="~/.ssh/id_ed25519"
                  />
                  <Button variant="secondary" onClick={() => void browseKey()}>
                    <FolderOpen className="size-3.5" />
                  </Button>
                </div>
              </Field>
              <Field label="Passphrase (optional)">
                <Input
                  type="password"
                  value={secret}
                  onChange={(e) => onSecret(e.target.value)}
                  placeholder={hasSavedSecret ? '•••••••• (saved)' : 'If the key has one'}
                />
              </Field>
            </div>
          )}
          {ssh.auth === 'password' && (
            <Field label="SSH password" hint="Stored in the OS credential manager">
              <Input
                type="password"
                value={secret}
                onChange={(e) => onSecret(e.target.value)}
                placeholder={hasSavedSecret ? '•••••••• (saved)' : ''}
              />
            </Field>
          )}
          <Field label="Jump host (optional)" hint="Passed to ssh -J, e.g. user@gateway:22">
            <Input
              value={ssh.jumpHost}
              onChange={(e) => patch({ jumpHost: e.target.value })}
              placeholder="None"
            />
          </Field>
          <p className="text-[11px] leading-snug text-faint">
            The database host and port above are resolved on the SSH server, so localhost means the
            server itself. New host keys are trusted on first use; a changed key is refused.
          </p>
        </>
      )}
    </div>
  )
}
