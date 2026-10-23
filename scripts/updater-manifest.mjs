// Builds the updater's latest.json from the signed bundles on a release.
//
//   node scripts/updater-manifest.mjs <assets dir> <version> <tag> <owner/repo>
//
// Every platform job uploads its bundles and `.sig` files to the same draft
// release; generating the manifest once afterwards avoids jobs racing to edit it.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Updater platform keys for a signed bundle file name, most specific first. */
export function platformKeys(name) {
  if (/x64-setup\.exe$/.test(name)) return ['windows-x86_64-nsis', 'windows-x86_64']
  if (/x64_[\w-]+\.msi$/.test(name)) return ['windows-x86_64-msi']
  if (/arm64-setup\.exe$/.test(name)) return ['windows-aarch64-nsis', 'windows-aarch64']
  if (/universal\.app\.tar\.gz$/.test(name)) {
    return ['darwin-aarch64-app', 'darwin-aarch64', 'darwin-x86_64-app', 'darwin-x86_64']
  }
  if (/(aarch64|arm64)\.app\.tar\.gz$/.test(name)) return ['darwin-aarch64-app', 'darwin-aarch64']
  if (/(x64|x86_64)\.app\.tar\.gz$/.test(name)) return ['darwin-x86_64-app', 'darwin-x86_64']
  if (/(amd64|x86_64)\.AppImage$/.test(name)) return ['linux-x86_64-appimage', 'linux-x86_64']
  if (/(aarch64|arm64)\.AppImage$/.test(name)) return ['linux-aarch64-appimage', 'linux-aarch64']
  if (/amd64\.deb$/.test(name)) return ['linux-x86_64-deb']
  if (/arm64\.deb$/.test(name)) return ['linux-aarch64-deb']
  if (/x86_64\.rpm$/.test(name)) return ['linux-x86_64-rpm']
  if (/aarch64\.rpm$/.test(name)) return ['linux-aarch64-rpm']
  return []
}

export function buildManifest({ files, readSignature, version, tag, repo, notes, date }) {
  const platforms = {}
  for (const name of files) {
    if (!files.includes(`${name}.sig`)) continue
    const entry = {
      signature: readSignature(`${name}.sig`).trim(),
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`
    }
    for (const key of platformKeys(name)) {
      // The first bundle claiming a key keeps it (NSIS sorts before MSI)
      if (!platforms[key]) platforms[key] = entry
    }
  }
  return { version, notes, pub_date: date, platforms }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, version, tag, repo] = process.argv.slice(2)
  if (!dir || !version || !tag || !repo) {
    console.error('usage: updater-manifest.mjs <assets dir> <version> <tag> <owner/repo>')
    process.exit(1)
  }
  const files = readdirSync(dir).sort(
    (a, b) => Number(a.endsWith('.msi')) - Number(b.endsWith('.msi'))
  )
  const manifest = buildManifest({
    files,
    readSignature: (name) => readFileSync(join(dir, name), 'utf8'),
    version,
    tag,
    repo,
    notes: `See https://github.com/${repo}/releases/tag/${tag}`,
    date: new Date().toISOString()
  })
  const required = ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64', 'linux-x86_64']
  const missing = required.filter((key) => !manifest.platforms[key])
  if (missing.length) {
    console.error(`Signed bundles missing for: ${missing.join(', ')}`)
    process.exit(1)
  }
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(Object.keys(manifest.platforms).join('\n'))
}
