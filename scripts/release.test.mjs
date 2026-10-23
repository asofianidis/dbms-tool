import { describe, expect, it } from 'vitest'
import { releaseVersion } from './release-version.mjs'
import { buildManifest, platformKeys } from './updater-manifest.mjs'

describe('releaseVersion', () => {
  it('uses tags as-is', () => {
    expect(releaseVersion('0.1.0', 7, 'v1.2.3')).toBe('1.2.3')
    expect(() => releaseVersion('0.1.0', 7, 'v1.2.3-beta')).toThrow()
  })

  it('advances the patch by the run number on main', () => {
    expect(releaseVersion('0.1.0', 42, undefined, '0.1.0')).toBe('0.1.42')
  })

  it('releases a deliberate base bump unchanged', () => {
    expect(releaseVersion('0.2.0', 43, undefined, '0.1.0')).toBe('0.2.0')
  })

  it('respects MSI limits', () => {
    expect(() => releaseVersion('0.1.65000', 600, undefined, '0.1.65000')).toThrow(/MSI/)
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
