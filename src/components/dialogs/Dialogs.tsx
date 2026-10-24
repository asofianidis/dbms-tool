import { useState } from 'react'
import { AlertTriangle, KeyRound } from 'lucide-react'
import { connectionLabel, connectionSubtitle } from '@/lib/engines'
import { confirmStore, passwordPromptStore, promptStore } from '@/lib/workspace'
import { Button, EngineMark, Field, Input, Modal, Toggle } from '../ui'

export function PasswordPromptHost(): React.JSX.Element | null {
  const request = passwordPromptStore.use()
  if (!request) return null
  return <PasswordPrompt key={request.connection.id + (request.error ?? '')} />
}

function PasswordPrompt(): React.JSX.Element | null {
  const request = passwordPromptStore.get()
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  if (!request) return null
  const { connection, error, resolve } = request
  const finish = (result: { password: string; remember: boolean } | null): void => {
    passwordPromptStore.set(null)
    resolve(result)
  }
  return (
    <Modal
      width="sm"
      icon={<EngineMark engine={connection.engine} size="lg" />}
      title={`Connect to ${connectionLabel(connection)}`}
      description={connectionSubtitle(connection)}
      onClose={() => finish(null)}
      footer={
        <>
          <Button variant="secondary" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => finish({ password, remember })}>
            <KeyRound className="size-3.5" /> Connect
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          finish({ password, remember })
        }}
      >
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </Field>
        {error && <p className="text-xs whitespace-pre-wrap text-danger">{error}</p>}
        <Toggle
          checked={remember}
          onChange={setRemember}
          label="Remember password"
          description="Saved to the OS credential manager"
        />
      </form>
    </Modal>
  )
}

export function ConfirmHost(): React.JSX.Element | null {
  const request = confirmStore.use()
  if (!request) return null
  return <ConfirmDialog key={request.title + (request.code ?? '')} />
}

function ConfirmDialog(): React.JSX.Element | null {
  const request = confirmStore.get()
  const [typed, setTyped] = useState('')
  if (!request) return null
  const blocked = !!request.typeToConfirm && typed.trim() !== request.typeToConfirm
  const finish = (ok: boolean): void => {
    confirmStore.set(null)
    request.resolve(ok)
  }
  return (
    <Modal
      width={request.code ? 'lg' : 'sm'}
      icon={
        request.danger ? (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
            <AlertTriangle className="size-4" />
          </span>
        ) : undefined
      }
      title={request.title}
      onClose={() => finish(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => finish(false)}>
            Cancel
          </Button>
          <Button
            variant={request.danger ? 'danger' : 'primary'}
            disabled={blocked}
            onClick={() => finish(true)}
            data-autofocus
          >
            {request.confirmLabel ?? 'Continue'}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px] text-fg">
        <div>{request.message}</div>
        {request.code && (
          <pre className="max-h-[40vh] overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg select-text">
            {request.code}
          </pre>
        )}
        {request.typeToConfirm && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!blocked) finish(true)
            }}
          >
            <Field label={`Type ${request.typeToConfirm} to confirm`}>
              <Input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={request.typeToConfirm}
                spellCheck={false}
                autoComplete="off"
                mono
              />
            </Field>
          </form>
        )}
      </div>
    </Modal>
  )
}

export function PromptHost(): React.JSX.Element | null {
  const request = promptStore.use()
  if (!request) return null
  return <PromptDialog key={request.title} />
}

function PromptDialog(): React.JSX.Element | null {
  const request = promptStore.get()
  const [value, setValue] = useState(request?.initial ?? '')
  if (!request) return null
  const finish = (result: string | null): void => {
    promptStore.set(null)
    request.resolve(result)
  }
  return (
    <Modal
      width="sm"
      title={request.title}
      onClose={() => finish(null)}
      footer={
        <>
          <Button variant="secondary" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!value.trim()} onClick={() => finish(value)}>
            {request.confirmLabel ?? 'OK'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) finish(value)
        }}
      >
        <Field label={request.label}>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={request.placeholder}
            autoFocus
          />
        </Field>
      </form>
    </Modal>
  )
}
