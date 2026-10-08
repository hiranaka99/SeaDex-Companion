export const cx = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(' ')

export const tabHeader =
  'mb-[22px] flex flex-wrap items-start justify-between gap-5 [&_h2]:mb-1 [&_h2]:text-[26px] [&_h2]:font-extrabold'

export const subtitle = 'm-0 text-[13.5px] text-muted'

export const actions = 'flex items-center gap-2.5'

export const buttonBase =
  'inline-flex cursor-pointer items-center gap-2 whitespace-normal rounded-control border px-4 py-2.5 text-sm font-semibold transition-all duration-150 [&_svg]:shrink-0 disabled:cursor-not-allowed disabled:opacity-60'

export const buttonPrimary =
  `${buttonBase} border-transparent bg-linear-to-b from-accent-bright to-accent text-on-accent shadow-[0_6px_18px_rgba(79,140,255,0.35)] enabled:hover:-translate-y-px enabled:hover:shadow-[0_10px_24px_rgba(79,140,255,0.45)]`

export const control =
  'rounded-control border border-muted-dim/65 bg-panel px-3.5 py-2.5 text-sm text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-dim max-[600px]:text-base focus:border-accent focus:shadow-[0_0_0_3px_rgba(79,140,255,0.12)]'

export const countBadge =
  'rounded-full border border-line-strong bg-accent/15 px-3.5 py-2 text-sm font-extrabold text-ink'

/** Status text uses the same meaning on cards, details, and the downloads page. */
export function downloadTextTone(state: string): string {
  if (state === 'complete') return 'text-good'
  if (state === 'error') return 'text-bad'
  if (state === 'paused') return 'text-warn'
  if (state === 'downloading' || state === 'sending') return 'text-accent-bright'
  return 'text-muted'
}

export const panelCard = 'rounded-card border border-line bg-panel px-[22px] py-5'
