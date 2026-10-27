/** Building blocks of the Settings tab */

export function Row({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-8 border-b border-line py-4 last:border-0">
      <div className="min-w-0">
        <p className="text-bright">{title}</p>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-8">
      <h2 className="mb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">
        {title}
      </h2>
      <div className="rounded-lg border border-line bg-panel/70 px-4">{children}</div>
    </section>
  )
}
