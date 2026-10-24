import { PlugZap } from 'lucide-react'
import type { ConnectionConfig } from '@/lib/api'
import { cn } from '@/lib/cn'
import { connectionLabel } from '@/lib/engines'
import { queryClient } from '@/lib/queries'
import { keyType } from '@/lib/redis'
import { connect } from '@/lib/workspace'
import { Button, EmptyState } from '@/components/ui'

export function TypeBadge({
  type,
  className
}: {
  type: string
  className?: string
}): React.JSX.Element {
  const t = keyType(type)
  return (
    <span
      title={t.label}
      className={cn(
        'inline-flex h-4 w-10 shrink-0 items-center justify-center rounded-[3px] font-mono text-[9px] font-semibold tracking-tight',
        t.tone,
        className
      )}
    >
      {t.short}
    </span>
  )
}

export function NotConnected({
  connection
}: {
  connection: ConnectionConfig | undefined
}): React.JSX.Element {
  return (
    <EmptyState
      icon={<PlugZap className="size-6" />}
      title={connection ? `Not connected to ${connectionLabel(connection)}` : 'Pick a connection'}
      actions={
        connection && (
          <Button size="sm" variant="primary" onClick={() => void connect(connection.id)}>
            Connect
          </Button>
        )
      }
    />
  )
}

/** Key counts in the explorer and pickers go stale after writes. */
export function refreshKeyCounts(connectionId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['conn', connectionId, 'databases'] })
}
