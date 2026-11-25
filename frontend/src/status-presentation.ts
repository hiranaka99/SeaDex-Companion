import type { IconName } from './components/Icons'
import type { CardStatus } from './types'

/**
 * One glyph and colour per library status, shared by card badges, section headings, the status
 * filter row and the status guide. Each status keeps a glyph of its own so it never relies on colour.
 */
export const STATUS_PRESENTATION: Record<CardStatus, { icon: IconName; tone: string }> = {
  review: { icon: 'search', tone: 'text-warn' },
  upgrade: { icon: 'arrow-up', tone: 'text-accent-bright' },
  partial: { icon: 'alert', tone: 'text-warn' },
  missing: { icon: 'minus', tone: 'text-muted' },
  best: { icon: 'check', tone: 'text-good' },
}

/** Display order of statuses, matching the recommended sort. */
export const STATUS_ORDER: CardStatus[] = ['review', 'upgrade', 'partial', 'missing', 'best']

/** Plain-language meaning of each status and filter, for the status guide. */
export const STATUS_MEANING: Record<CardStatus | 'episodes' | 'unseen', string> = {
  review: 'The AniList match is uncertain. Confirm or correct it in Details before trusting anything else on the card.',
  upgrade: 'SeaDex recommends a release you do not own yet.',
  partial: 'SeaDex covers some seasons or cours of this title, but not all of them.',
  missing: 'SeaDex lists no release for this title, or your release preferences exclude every release it lists.',
  best: 'You already have the release SeaDex recommends.',
  episodes: 'Your library is missing episodes of at least one season.',
  unseen: 'SeaDex changed a recommendation since you last marked it reviewed.',
}
