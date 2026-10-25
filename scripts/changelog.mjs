// Writes the changelog for a release from the commits on main since the previous release.
//
//   node scripts/changelog.mjs <previous tag or ''> [ref]
//
// Pull request merges are listed by their title. The output (### sections of - bullets) is used
// in the GitHub release and as the updater notes the app shows on its update button.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const MERGE_PR = /^Merge pull request #(\d+) from (\S+)/
const DEPENDENCY = /^(Bump|Update|build\(deps(-dev)?\)|chore\(deps(-dev)?\))\b/i
/** Cap for a first release with no previous tag. */
const MAX_ENTRIES = 50

/** Turns `git log` commits ({ subject, body }) into changelog entries, newest first. */
export function changelogEntries(commits) {
  const entries = []
  for (const { subject, body } of commits) {
    const merge = MERGE_PR.exec(subject)
    if (merge) {
      const [, number, branch] = merge
      const title =
        body
          .split('\n')
          .find((line) => line.trim())
          ?.trim() || branch
      const bot = /(^|\/)(dependabot|renovate)\//.test(branch)
      entries.push({ text: `${title} (#${number})`, dependency: bot || DEPENDENCY.test(title) })
    } else if (!/^Merge (branch|remote-tracking branch) /.test(subject)) {
      entries.push({ text: subject, dependency: DEPENDENCY.test(subject) })
    }
  }
  return entries
}

export function renderChangelog(entries) {
  const changes = entries.filter((e) => !e.dependency)
  const deps = entries.filter((e) => e.dependency)
  const sections = []
  if (changes.length)
    sections.push(['### Changes', ...changes.map((e) => `- ${e.text}`)].join('\n'))
  if (deps.length) sections.push(['### Dependencies', ...deps.map((e) => `- ${e.text}`)].join('\n'))
  return sections.join('\n\n') || '### Changes\n- Maintenance only'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [previous, ref = 'HEAD'] = process.argv.slice(2)
  const range = previous ? [`${previous}..${ref}`] : [ref, `--max-count=${MAX_ENTRIES}`]
  const log = execFileSync('git', ['log', '--first-parent', '--format=%s%x1f%b%x1e', ...range], {
    encoding: 'utf8'
  })
  const commits = log
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim())
    .map((record) => {
      const [subject, body = ''] = record.split('\x1f')
      return { subject: subject.trim(), body }
    })
  console.log(renderChangelog(changelogEntries(commits)))
}
