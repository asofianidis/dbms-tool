export interface ChangelogSection {
  heading: string | null
  items: string[]
}

/**
 * Reads the release notes the release workflow writes (`### Heading` lines and `- item` bullets)
 * into sections, dropping Markdown links down to their text.
 */
export function parseChangelog(notes: string): ChangelogSection[] {
  const sections: ChangelogSection[] = []
  let section: ChangelogSection | null = null
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim().replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    if (!line) continue
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      section = { heading: heading[1], items: [] }
      sections.push(section)
      continue
    }
    if (!section) {
      section = { heading: null, items: [] }
      sections.push(section)
    }
    section.items.push(line.replace(/^[-*]\s+/, ''))
  }
  return sections.filter((s) => s.items.length > 0)
}
