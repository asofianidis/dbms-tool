import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { FolderOpen } from 'lucide-react'
import type { ConnectionConfig } from '@/lib/api'
import { Button, Field, Input } from '../ui'

type TlsFiles = Pick<ConnectionConfig, 'sslRootCert' | 'sslClientCert' | 'sslClientKey'>

function FileInput({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (path: string) => void
  placeholder: string
}): React.JSX.Element {
  const browse = async (): Promise<void> => {
    const path = await openDialog({ multiple: false })
    if (typeof path === 'string') onChange(path)
  }
  return (
    <div className="flex gap-2">
      <Input
        mono
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      <Button variant="secondary" onClick={() => void browse()}>
        <FolderOpen className="size-3.5" />
      </Button>
    </div>
  )
}

/** CA and client certificate files, shown while TLS can be on. */
export function TlsFields({
  config,
  onChange
}: {
  config: ConnectionConfig
  onChange: (patch: TlsFiles) => void
}): React.JSX.Element {
  // MongoDB reads the certificate and its key from one PEM file, and MySQL
  // takes a PKCS#12 bundle, so only the others have a separate key
  const mongo = config.engine === 'mongo'
  const separateKey = !mongo && config.engine !== 'mysql'
  return (
    <div className={separateKey ? 'grid grid-cols-3 gap-3' : 'grid grid-cols-2 gap-3'}>
      <Field
        label="CA certificate"
        hint={mongo ? 'Replaces the built-in roots' : "Trusted alongside the system's roots"}
      >
        <FileInput
          value={config.sslRootCert ?? ''}
          onChange={(sslRootCert) => onChange({ sslRootCert })}
          placeholder="ca.pem"
        />
      </Field>
      <Field
        label={mongo ? 'Client certificate + key' : 'Client certificate'}
        hint={
          mongo
            ? 'One PEM file holding both'
            : separateKey
              ? 'PEM, or a .p12/.pfx bundle'
              : 'A .p12/.pfx bundle without a password'
        }
      >
        <FileInput
          value={config.sslClientCert ?? ''}
          onChange={(sslClientCert) => onChange({ sslClientCert })}
          placeholder={mongo ? 'client.pem' : separateKey ? 'client.crt' : 'client.p12'}
        />
      </Field>
      {separateKey && (
        <Field label="Client key" hint="PKCS#8 PEM; empty for a .p12/.pfx">
          <FileInput
            value={config.sslClientKey ?? ''}
            onChange={(sslClientKey) => onChange({ sslClientKey })}
            placeholder="client.key"
          />
        </Field>
      )}
    </div>
  )
}
