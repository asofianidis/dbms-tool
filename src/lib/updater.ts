import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { openUrl } from '@tauri-apps/plugin-opener'
import { settingsStore, type UpdateChannel } from './settings'
import { createStore } from './store'
import { errorMessage } from './toast'

export const RELEASES_URL = 'https://github.com/asofianidis/dbms-tool/releases'

export type UpdateState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'current'; checkedAt: number }
  | { state: 'downloading'; version: string; progress: number | null; notes: string | null }
  | { state: 'ready'; version: string; notes: string | null }
  | { state: 'installing'; version: string }
  | { state: 'error'; error: string; version?: string }

export const updateStore = createStore<UpdateState>({ state: 'idle' })

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

let pending: Update | null = null
let running: Promise<void> | null = null

/** Nightly builds carry a pre-release version such as 0.1.37-12. */
export function isNightlyVersion(version: string): boolean {
  return version.includes('-')
}

/** The channel to update from: the chosen one, or the installed build's own. */
export async function updateChannel(): Promise<UpdateChannel> {
  const chosen = settingsStore.get().updateChannel
  if (chosen) return chosen
  return isNightlyVersion(await getVersion()) ? 'nightly' : 'stable'
}

type UpdateMetadata = ConstructorParameters<typeof Update>[0]

/** Like the updater plugin's `check`, but against the channel's manifest. */
async function check(): Promise<Update | null> {
  const metadata = await invoke<UpdateMetadata | null>('update_check', {
    channel: await updateChannel()
  })
  return metadata ? new Update(metadata) : null
}

/**
 * Checks GitHub Releases for a newer signed build and downloads it in the
 * background. Installing waits for the user, so a running query is never cut off.
 */
export function checkForUpdates(manual = false): Promise<void> {
  if (running) return running
  running = (async () => {
    const current = updateStore.get()
    if (current.state === 'ready' || current.state === 'installing') return
    updateStore.set({ state: 'checking' })
    try {
      const update = await check()
      if (!update) {
        updateStore.set({ state: 'current', checkedAt: Date.now() })
        return
      }
      await pending?.close().catch(() => {})
      pending = update
      let total = 0
      let received = 0
      const notes = update.body?.trim() || null
      updateStore.set({ state: 'downloading', version: update.version, progress: null, notes })
      await update.download((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0
        else if (event.event === 'Progress') {
          received += event.data.chunkLength
          updateStore.set({
            state: 'downloading',
            version: update.version,
            progress: total ? Math.round((received / total) * 100) : null,
            notes
          })
        }
      })
      updateStore.set({ state: 'ready', version: update.version, notes })
    } catch (e) {
      // Offline, rate limited or a dev build without a signing key: stay quiet unless asked
      if (manual) updateStore.set({ state: 'error', error: errorMessage(e) })
      else updateStore.set({ state: 'idle' })
    }
  })().finally(() => {
    running = null
  })
  return running
}

/** Drops any update fetched from the previous channel and checks the new one. */
export async function switchUpdateChannel(channel: UpdateChannel | ''): Promise<void> {
  settingsStore.set((s) => ({ ...s, updateChannel: channel }))
  await running?.catch(() => {})
  const current = updateStore.get()
  if (current.state === 'installing') return
  await pending?.close().catch(() => {})
  pending = null
  updateStore.set({ state: 'idle' })
  if (!import.meta.env.DEV) await checkForUpdates(true)
}

export async function installUpdate(): Promise<void> {
  const update = pending
  const current = updateStore.get()
  if (!update || current.state !== 'ready') return
  updateStore.set({ state: 'installing', version: update.version })
  try {
    await update.install()
    await relaunch()
  } catch (e) {
    // Linux .deb/.rpm installs can't self-update; point people at the release instead
    updateStore.set({ state: 'error', error: errorMessage(e), version: update.version })
  }
}

export function openReleasePage(version?: string): void {
  void openUrl(version ? `${RELEASES_URL}/tag/v${version}` : RELEASES_URL)
}

/** Starts background checks shortly after launch and then every few hours. */
export function startUpdateChecks(): () => void {
  if (import.meta.env.DEV) return () => {}
  const tick = (): void => {
    if (settingsStore.get().autoUpdate) void checkForUpdates()
  }
  const first = setTimeout(tick, 8_000)
  const timer = setInterval(tick, CHECK_EVERY_MS)
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}
