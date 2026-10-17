/**
 * A plugin's icon (F-25): an SVG the runtime checked and keyed by content hash,
 * or a name from Velloc's own icon set. Each hash becomes ONE `blob:` URL in
 * this realm however many rows draw it; a `mask` icon takes the text colour.
 */
import * as React from 'react'
import {
  BookOpenIcon,
  BotIcon,
  BugIcon,
  CalendarIcon,
  CodeIcon,
  DatabaseIcon,
  FileTextIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  ImageIcon,
  ListChecksIcon,
  MessageCircleIcon,
  PencilIcon,
  PlayIcon,
  PuzzleIcon,
  RocketIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StarIcon,
  TerminalIcon,
  UsersIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react'

import type { ContributionIcon } from '../../runtimeProtocol/modContributions'
import { cn } from '../../../lib/utils'

/** The names `lucide:<name>` may use; any other draws the generic icon. */
export const MOD_LUCIDE_ICONS: Readonly<Record<string, LucideIcon>> = {
  'book-open': BookOpenIcon,
  bot: BotIcon,
  bug: BugIcon,
  calendar: CalendarIcon,
  code: CodeIcon,
  database: DatabaseIcon,
  'file-text': FileTextIcon,
  folder: FolderIcon,
  'git-branch': GitBranchIcon,
  globe: GlobeIcon,
  image: ImageIcon,
  'list-checks': ListChecksIcon,
  'message-circle': MessageCircleIcon,
  pencil: PencilIcon,
  play: PlayIcon,
  puzzle: PuzzleIcon,
  rocket: RocketIcon,
  search: SearchIcon,
  'shield-check': ShieldCheckIcon,
  sparkles: SparklesIcon,
  star: StarIcon,
  terminal: TerminalIcon,
  users: UsersIcon,
  wrench: WrenchIcon,
  zap: ZapIcon,
}

const urls = new Map<string, string>()

/** The realm's `blob:` URL for the icon `hash`; undefined when `icons` lacks it. */
export function modIconUrl(hash: string, icons: Readonly<Record<string, string>>): string | undefined {
  const cached = urls.get(hash)
  if (cached) return cached
  const svg = icons[hash]
  if (svg === undefined) return undefined
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  urls.set(hash, url)
  return url
}

/** Release the URLs of hashes no longer in `icons`. */
export function releaseModIconUrls(icons: Readonly<Record<string, string>>): void {
  for (const [hash, url] of urls) {
    if (hash in icons) continue
    URL.revokeObjectURL(url)
    urls.delete(hash)
  }
}

export function ModIcon({
  icon,
  icons,
  className,
}: {
  icon: ContributionIcon | undefined
  icons: Readonly<Record<string, string>>
  className?: string
}): React.ReactElement {
  if (!icon) return <PuzzleIcon className={className} aria-hidden />
  if ('lucide' in icon) {
    const Lucide = MOD_LUCIDE_ICONS[icon.lucide] ?? PuzzleIcon
    return <Lucide className={className} aria-hidden />
  }
  const light = modIconUrl(icon.ref, icons)
  if (!light) return <PuzzleIcon className={className} aria-hidden />
  if (icon.mask) {
    return (
      <span
        aria-hidden
        className={cn('inline-block shrink-0 bg-current', className)}
        style={{
          maskImage: `url(${light})`,
          WebkitMaskImage: `url(${light})`,
          maskSize: 'contain',
          WebkitMaskSize: 'contain',
          maskRepeat: 'no-repeat',
          WebkitMaskRepeat: 'no-repeat',
          maskPosition: 'center',
          WebkitMaskPosition: 'center',
        }}
      />
    )
  }
  const dark = icon.dark ? modIconUrl(icon.dark, icons) : undefined
  if (!dark) return <img src={light} className={className} alt="" aria-hidden draggable={false} />
  return (
    <>
      <img src={light} className={cn(className, 'dark:hidden')} alt="" aria-hidden draggable={false} />
      <img src={dark} className={cn(className, 'hidden dark:inline-block')} alt="" aria-hidden draggable={false} />
    </>
  )
}
