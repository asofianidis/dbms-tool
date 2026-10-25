import { describe, expect, it } from 'vitest'
import { changelogEntries, renderChangelog } from './changelog.mjs'
import { previousTag, releaseVersion } from './release-version.mjs'
import { buildManifest, platformKeys } from './updater-manifest.mjs'

describe('releaseVersion', () => {
  const tags = ['v0.1.30', 'v0.1.35', 'v0.1.36-210', 'v0.1.4', 'nightly', 'v0.1.35-180']

  it('uses tags as-is', () => {
    expect(releaseVersion({ base: '0.1.0', tag: 'v1.2.3', tags })).toBe('1.2.3')
    expect(() => releaseVersion({ base: '0.1.0', tag: 'v1.2.3-beta', tags })).toThrow()
  })

  it('releases the patch after the newest stable tag', () => {
    expect(releaseVersion({ base: '0.1.0', channel: 'stable', tags })).toBe('0.1.36')
    expect(releaseVersion({ base: '0.1.0', channel: 'stable', tags: [] })).toBe('0.1.0')
  })

  it('releases a deliberate base bump unchanged', () => {
    expect(releaseVersion({ base: '0.2.0', channel: 'stable', tags })).toBe('0.2.0')
  })

  it('numbers nightlies as pre-releases of the next stable version', () => {
    expect(releaseVersion({ base: '0.1.0', channel: 'nightly', runNumber: 215, tags })).toBe(
      '0.1.36-215'
    )
    expect(() => releaseVersion({ base: '0.1.0', channel: 'nightly', tags })).toThrow()
    expect(() =>
      releaseVersion({ base: '0.1.0', channel: 'nightly', runNumber: 70000, tags })
    ).toThrow(/65535/)
  })

  it('respects MSI limits', () => {
    expect(() =>
      releaseVersion({ base: '0.1.65535', channel: 'stable', tags: ['v0.1.65535'] })
    ).toThrow(/MSI/)
  })
})

describe('previousTag', () => {
  const tags = ['v0.1.30', 'v0.1.35', 'v0.1.36-210', 'v0.1.35-180', 'nightly']

  it('compares stable releases with stable releases', () => {
    expect(previousTag(tags, 'stable', 'v0.1.36')).toBe('v0.1.35')
  })

  it('compares nightlies with the newest release of either channel', () => {
    expect(previousTag(tags, 'nightly', 'v0.1.36-215')).toBe('v0.1.36-210')
    expect(previousTag(['v0.1.35-180', 'v0.1.35'], 'nightly', 'v0.1.36-1')).toBe('v0.1.35')
  })
})

describe('changelog', () => {
  it('lists pull requests by title and separates dependency updates', () => {
    const entries = changelogEntries([
      { subject: 'Merge pull request #26 from o/fix/scan', body: 'Fix escaping issues\n' },
      { subject: 'Merge pull request #23 from o/dependabot/cargo/bson', body: 'Bump bson\n' },
      { subject: "Merge branch 'main' into feature", body: '' },
      { subject: 'Tweak the grid (#30)', body: '' }
    ])
    expect(renderChangelog(entries)).toBe(
      [
        '### Changes',
        '- Fix escaping issues (#26)',
        '- Tweak the grid (#30)',
        '',
        '### Dependencies',
        '- Bump bson (#23)'
      ].join('\n')
    )
  })
})

describe('updater manifest', () => {
  const files = [
    'dbms-tool_0.1.5_x64-setup.exe',
    'dbms-tool_0.1.5_x64-setup.exe.sig',
    'dbms-tool_0.1.5_x64_en-US.msi',
    'dbms-tool_0.1.5_x64_en-US.msi.sig',
    'dbms-tool_0.1.5_universal.app.tar.gz',
    'dbms-tool_0.1.5_universal.app.tar.gz.sig',
    'dbms-tool_0.1.5_universal.dmg',
    'dbms-tool_0.1.5_amd64.AppImage',
    'dbms-tool_0.1.5_amd64.AppImage.sig',
    'dbms-tool_0.1.5_aarch64.AppImage',
    'dbms-tool_0.1.5_aarch64.AppImage.sig',
    'dbms-tool_0.1.5_amd64.deb'
  ]

  it('maps every signed bundle to its platforms', () => {
    const manifest = buildManifest({
      files,
      readSignature: (name) => `sig:${name}\n`,
      version: '0.1.5',
      tag: 'v0.1.5',
      repo: 'o/r',
      notes: '',
      date: '2026-01-01T00:00:00Z'
    })
    expect(manifest.platforms['windows-x86_64'].url).toBe(
      'https://github.com/o/r/releases/download/v0.1.5/dbms-tool_0.1.5_x64-setup.exe'
    )
    expect(manifest.platforms['windows-x86_64-msi'].signature).toBe(
      'sig:dbms-tool_0.1.5_x64_en-US.msi.sig'
    )
    expect(manifest.platforms['darwin-aarch64']).toEqual(manifest.platforms['darwin-x86_64'])
    expect(manifest.platforms['linux-aarch64'].url).toMatch(/aarch64\.AppImage$/)
    // Bundles without a .sig (dmg, this deb) aren't offered as updates
    expect(manifest.platforms['linux-x86_64-deb']).toBeUndefined()
  })

  it('ignores files it does not recognise', () => {
    expect(platformKeys('SHA256SUMS.txt')).toEqual([])
  })
})
