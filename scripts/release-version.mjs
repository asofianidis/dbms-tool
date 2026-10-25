// Decides the channel, version and previous release for a release build.
//
// - Stable releases are made by hand: pushing a vX.Y.Z tag releases that version, and running
//   the workflow for the stable channel releases the next patch after the newest stable tag
//   (or the base version in tauri.conf.json, when that was bumped past it).
// - Nightly builds are that upcoming stable version with the workflow run number as a numeric
//   pre-release (0.1.37-412), so they sort after the last stable release and before the next.
//   They are skipped when the app hasn't changed since the newest release of either channel.
import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([1-9]\d*))?$/

/** Paths whose changes are worth a nightly build. */
export const APP_PATHS = [
  'src',
  'src-tauri',
  'index.html',
  'package.json',
  'pnpm-lock.yaml',
  'vite.config.ts',
  'scripts/release-version.mjs',
  'scripts/updater-manifest.mjs',
  'scripts/changelog.mjs',
  '.github/workflows/release.yml'
]

/** Parses a release tag (vX.Y.Z or nightly vX.Y.Z-N); other tags give null. */
export function parseTag(tag) {
  const m = RELEASE_TAG.exec(tag)
  if (!m) return null
  return { tag, version: [1, 2, 3].map((i) => Number(m[i])), nightly: m[4] ? Number(m[4]) : null }
}

/** Semver order: a nightly sorts before the stable release of the same version. */
export function compareTags(a, b) {
  for (let i = 0; i < 3; i++) if (a.version[i] !== b.version[i]) return a.version[i] - b.version[i]
  if (a.nightly === b.nightly) return 0
  if (a.nightly === null) return 1
  if (b.nightly === null) return -1
  return a.nightly - b.nightly
}

/** The newest release tag before this one: stable only for stable, either channel for nightly. */
export function previousTag(tags, channel, current) {
  const candidates = tags
    .filter((tag) => tag !== current)
    .map(parseTag)
    .filter((t) => t && (channel === 'nightly' || t.nightly === null))
    .sort(compareTags)
  return candidates.at(-1)?.tag ?? null
}

export function releaseVersion({ base, channel, runNumber, tag, tags }) {
  if (tag) {
    const version = tag.replace(/^v/, '')
    if (!STABLE.test(version)) throw new Error('Release tags must be stable versions (vX.Y.Z)')
    return version
  }
  if (!STABLE.test(base)) throw new Error('The base version in tauri.conf.json must be X.Y.Z')
  const latest = previousTag(tags, 'stable')
  let [major, minor, patch] = base.split('.').map(Number)
  if (latest) {
    const next = parseTag(latest).version
    next[2] += 1
    // A base version bumped past the last release is released as-is
    if (
      compareTags(
        { version: next, nightly: null },
        { version: [major, minor, patch], nightly: null }
      ) > 0
    ) {
      ;[major, minor, patch] = next
    }
  }
  // MSI ProductVersion fields are limited to 255.255.65535 (plus a 65535 build number)
  if (major > 255 || minor > 255 || patch > 65535) {
    throw new Error('Version exceeds Windows MSI limits; increase the base minor version')
  }
  const version = `${major}.${minor}.${patch}`
  if (channel === 'stable') return version
  if (channel !== 'nightly') throw new Error(`Unknown release channel: ${channel}`)
  const n = Number(runNumber)
  if (!/^[1-9]\d*$/.test(String(runNumber)) || n > 65535) {
    throw new Error('Nightly builds need a workflow run number between 1 and 65535')
  }
  return `${version}-${n}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
  const isTag = process.env.GITHUB_REF_TYPE === 'tag'
  const channel = isTag ? 'stable' : process.env.CHANNEL || 'stable'
  const tags = git('tag', '--list', 'v*').split('\n').filter(Boolean)
  const version = releaseVersion({
    base: config.version,
    channel,
    runNumber: process.env.GITHUB_RUN_NUMBER,
    tag: isTag ? process.env.GITHUB_REF_NAME : undefined,
    tags
  })
  const tag = `v${version}`
  const previous = previousTag(tags, channel, tag)

  let release = true
  if (channel === 'nightly' && previous) {
    // git diff --quiet exits 1 when there are differences
    try {
      execFileSync('git', ['diff', '--quiet', previous, 'HEAD', '--', ...APP_PATHS])
      release = false
    } catch {
      // Changed since the previous release
    }
  }

  const outputs = { release, channel, version, tag, previous_tag: previous ?? '' }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([k, v]) => `${k}=${v}\n`)
        .join('')
    )
  }
  console.log(JSON.stringify(outputs))
}
