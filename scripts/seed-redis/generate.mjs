// Writes the Redis seed dataset to stdout in the Redis protocol, for `redis-cli --pipe`.
//   node scripts/seed-redis/generate.mjs [--scale N] [--days N] [--db N] [--flush]
// --db selects the database first; --flush empties it before loading.
import { redisSeedBatches } from './commands.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? fallback : args[i + 1]
}
const scale = Number(opt('scale', '0.01'))
const days = Number(opt('days', '1'))
const db = opt('db', null)

function resp(command) {
  let out = `*${command.length}\r\n`
  for (const arg of command) out += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`
  return out
}

/** Writes and waits when the pipe is full, so memory stays at one batch. */
function write(text) {
  return process.stdout.write(text) ? null : new Promise((r) => process.stdout.once('drain', r))
}

const head = []
if (db !== null) head.push(['SELECT', db])
if (args.includes('--flush')) head.push(['FLUSHDB'])
await write(head.map(resp).join(''))

let rows = 0
let commands = 0
for (const batch of redisSeedBatches(scale, days)) {
  rows += batch.rows
  commands += batch.commands.length
  const wait = write(batch.commands.map(resp).join(''))
  if (wait) await wait
}
process.stderr.write(
  `Generated ${commands.toLocaleString()} commands for ${rows.toLocaleString()} records\n`
)
