import { describe, expect, it } from 'vitest'
import { confirm, confirmStore } from '../workspace'

/** Answers the open dialog the way the confirm dialog does. */
function answer(ok: boolean): void {
  const request = confirmStore.get()
  if (!request) throw new Error('No confirm open')
  confirmStore.set(null)
  request.resolve(ok)
}

describe('confirm', () => {
  it('asks queued confirms in turn, answering each', async () => {
    const shown: string[] = []
    const first = confirm({ title: 'a', message: '', onShow: () => shown.push('a') })
    const second = confirm({ title: 'b', message: '', onShow: () => shown.push('b') })
    const third = confirm({ title: 'c', message: '', onShow: () => shown.push('c') })
    expect(confirmStore.get()?.title).toBe('a')
    expect(shown).toEqual(['a'])
    answer(true)
    expect(confirmStore.get()?.title).toBe('b')
    answer(false)
    expect(confirmStore.get()?.title).toBe('c')
    answer(true)
    expect(confirmStore.get()).toBeNull()
    expect(shown).toEqual(['a', 'b', 'c'])
    expect(await Promise.all([first, second, third])).toEqual([true, false, true])
  })
})
