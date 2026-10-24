// Types for commands.mjs, which the app imports for its "Seed sample database" dialog.
export interface RedisSeedBatch {
  /** The entity being generated, e.g. orders */
  entity: string
  commands: string[][]
  /** Generated records behind this batch */
  rows: number
  /** Share of the dataset done, 0–1 */
  progress: number
}

export function rowCommands(table: string, row: Record<string, unknown>): string[][]
export function finishCommands(): string[][]
export function redisSeedBatches(
  scale: number,
  metricDays: number,
  batchSize?: number
): Generator<RedisSeedBatch>
