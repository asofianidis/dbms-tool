import { Bookmark, BookmarkCheck, ChevronDown } from 'lucide-react'
import { savedQueriesStore } from '@/lib/saved'
import { showMenuAt } from '@/components/ContextMenu'
import { Button } from '@/components/ui'
import { savedMenu, type EditorTab } from './actions'

/** Toolbar dropdown to save the tab's query or run a saved one in the tab. */
export function SavedButton({
  tab,
  text,
  disabled
}: {
  tab: EditorTab
  /** The editor's current text */
  text: () => string
  disabled?: boolean
}): React.JSX.Element {
  const linked = savedQueriesStore.use().find((q) => q.id === tab.savedQueryId)
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={disabled}
      title={
        linked
          ? `Saved as “${linked.name}”. Update it or run another saved query`
          : 'Save this query, or run a saved one here'
      }
      onClick={(e) => showMenuAt(e.currentTarget, savedMenu(tab, text()))}
    >
      {linked ? (
        <BookmarkCheck className="size-3.5 text-accent" />
      ) : (
        <Bookmark className="size-3.5" />
      )}
      Saved <ChevronDown className="size-3" />
    </Button>
  )
}
