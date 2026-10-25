import {
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import { statementAround } from './sql-completion'

/** A multi-word clause, completed one or more words at a time. */
export interface Phrase {
  /** The words, completed one or more at a time */
  words: string
  /** Snippet text after the last word, with `${field}` placeholders */
  tail?: string
  /** Only at the start of a statement */
  start?: boolean
  /** Only in statements whose text before the phrase matches */
  where?: RegExp
}

/**
 * Completes multi-word clauses. Each completes from whichever of its words is being typed,
 * so `FOR SYSTEM_TIME` offers `AS OF`, `ALL`… once `FOR ` is written.
 */
export function phraseCompletion<P extends Phrase>(
  phrases: P[],
  detail: (phrase: P) => string,
  /** What counts as the word being typed */
  wordPattern = /[\w$]*/
): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(wordPattern)
    if (!word || (word.from === word.to && !context.explicit)) return null
    const doc = context.state.doc.toString()
    const { from } = statementAround(doc, context.pos)
    const before = doc.slice(from, word.from)
    // The statement's words before the one being typed, most recent last
    const typed = before.trim() ? before.trim().split(/\s+/) : []
    const current = word.text.toUpperCase()
    const out: Completion[] = []
    for (const p of phrases) {
      const words = p.words.split(' ')
      // Longest overlap first, so `LEFT JOIN L` continues the phrase instead of restarting it
      for (let k = Math.min(words.length - 1, typed.length); k >= 0; k--) {
        // The phrase's first k words are the last k typed
        const lead = typed.slice(typed.length - k)
        if (lead.some((w, i) => w.toUpperCase() !== words[i])) continue
        if (!words[k].startsWith(current)) continue
        const rest = typed.slice(0, typed.length - k)
        if (p.start && rest.length) continue
        if (p.where && !p.where.test(rest.join(' '))) continue
        const label = words.slice(k).join(' ')
        out.push(
          snippetCompletion(label + (p.tail ?? ''), { label, detail: detail(p), type: 'keyword' })
        )
        break
      }
    }
    return out.length ? { from: word.from, options: out } : null
  }
}
