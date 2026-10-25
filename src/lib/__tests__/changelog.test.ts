import { describe, expect, it } from 'vitest'
import { parseChangelog } from '../changelog'

describe('parseChangelog', () => {
  it('splits headed sections and strips links', () => {
    const notes = [
      '### Changes',
      '- Fix the [grid](https://example.com) scroll (#26)',
      '',
      '### Dependencies',
      '- Bump bson to 3.1.0 (#23)',
      '### Empty'
    ].join('\n')
    expect(parseChangelog(notes)).toEqual([
      { heading: 'Changes', items: ['Fix the grid scroll (#26)'] },
      { heading: 'Dependencies', items: ['Bump bson to 3.1.0 (#23)'] }
    ])
  })

  it('keeps plain text without headings', () => {
    expect(parseChangelog('See the release page')).toEqual([
      { heading: null, items: ['See the release page'] }
    ])
  })
})
