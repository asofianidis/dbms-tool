import { errorMessage } from './toast'

/**
 * Whether a file read or write was refused because the user never picked the
 * path in a dialog (see `file_scope.rs`). Saving through the dialog again fixes it.
 */
export function notPickedInDialog(error: unknown): boolean {
  return errorMessage(error).includes('chosen in a file dialog')
}
