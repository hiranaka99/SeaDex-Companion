import { buttonBase } from '../styles'

// Both bulk reviews share structure; action and outcome colors retain their meaning.
export const bulkDialog = {
  shell: 'flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-line-strong bg-panel-raised shadow-[0_24px_70px_rgba(0,0,0,.55)]',
  header: 'bulk-dialog-header flex shrink-0 flex-wrap items-start gap-x-3 gap-y-2 border-b border-line px-5 py-4',
  body: 'app-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto p-5 max-[600px]:p-4',
  footer: 'bulk-dialog-footer flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-panel px-5 py-4',
  footerActions: 'ml-auto flex min-w-0 max-w-full flex-wrap justify-end gap-2 [&_button]:max-w-full [&_button]:justify-center [&_button]:wrap-anywhere max-[600px]:[&_button]:px-3',
  closeButton: 'grid touch-target size-9 cursor-pointer place-items-center rounded-lg text-muted hover:bg-panel hover:text-ink',
  row: 'flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-3 py-2 text-xs transition-colors',
  rowSelected: 'border-line bg-panel hover:border-line-strong',
  rowUnchecked: 'border-line/60 bg-canvas-soft text-muted',
  seasonBadge: 'rounded border border-line-strong bg-canvas-soft px-1.5 py-0.5 text-xs font-extrabold text-ink',
  neutralButton: `${buttonBase} border-line bg-panel-raised text-ink enabled:hover:text-ink`,
  downloadButton: `${buttonBase} border-good/35 bg-good/12 text-good enabled:hover:bg-good/20`,
  removeButton: `${buttonBase} border-bad/35 bg-bad/12 text-bad enabled:hover:bg-bad/20`,
}
