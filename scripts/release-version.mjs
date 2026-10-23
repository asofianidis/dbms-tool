// Decides the version for a release build and writes it into tauri.conf.json.
//
// - Tag builds (vX.Y.Z) use the tag.
// - Builds from main use the base version in tauri.conf.json with the patch
//   number advanced by the workflow run number, so every release is newer than
//   the last. Bumping the base version by hand starts a new named release.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function releaseVersion(base, runNumber, tag, previousBase) {
  if (tag) {
    const version = tag.replace(/^v/, '')
    if (!STABLE.test(version)) throw new Error('Release tags must be stable versions (vX.Y.Z)')
    return version
  }
  if (!STABLE.test(base) || !/^[1-9]\d*$/.test(String(runNumber))) {
    throw new Error('A stable base version and a positive workflow run number are required')
  }
  const [major, minor, patch] = base.split('.').map(Number)
  // A deliberate bump of the base version is released as-is
  const nextPatch = previousBase && previousBase !== base ? patch : patch + Number(runNumber)
  // MSI ProductVersion fields are limited to 255.255.65535
  if (major > 255 || minor > 255 || nextPatch > 65535) {
    throw new Error('Version exceeds Windows MSI limits; increase the base minor version')
  }
  return `${major}.${minor}.${nextPatch}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configPath = 'src-tauri/tauri.conf.json'
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const isTag = process.env.GITHUB_REF_TYPE === 'tag'
  let previousBase
  if (!isTag) {
    try {
      previousBase = JSON.parse(
        execFileSync('git', ['show', `HEAD^:${configPath}`], { encoding: 'utf8' })
      ).version
    } catch {
      // First commit or shallow history: treat as an automatic build
    }
  }
  const version = releaseVersion(
    config.version,
    process.env.GITHUB_RUN_NUMBER,
    isTag ? process.env.GITHUB_REF_NAME : undefined,
    previousBase
  )
  config.version = version
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=v${version}\n`)
  }
  console.log(version)
}
