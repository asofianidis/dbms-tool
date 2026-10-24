// Types for data.mjs, which the app imports for its "Seed sample database" dialog.
export type Emit = (table: string, row: Record<string, unknown>) => void

export const N: Record<'customers' | 'products' | 'orders' | 'reviews' | 'events' | 'tickets' | 'hosts', number>
export const NOW: number
export function configure(scale: number, days?: number): void
export class PgArray {
  constructor(items: string[])
  items: string[]
}
export function genReference(emit: Emit): void
export function plan(): [entity: string, gen: (i: number, emit: Emit) => void, count: number, chunk: number][]
