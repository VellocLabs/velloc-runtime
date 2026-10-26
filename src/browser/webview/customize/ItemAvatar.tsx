import * as React from 'react'

import { cn } from '@/lib/utils'

/** A stable hue (0–359) for a name, so the same item always gets the same tint. */
export function avatarHue(name: string): number {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) | 0
  return Math.abs(hash) % 360
}

/** A plugin's or connector's icon, or its initial on a tint of its own when it has none or the image fails. */
export function ItemAvatar({ name, iconUrl, className }: { name: string; iconUrl?: string; className?: string }) {
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => setBroken(false), [iconUrl])
  const box = cn('flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border', className)
  if (iconUrl && !broken) {
    return (
      <span className={cn(box, 'bg-background')}>
        <img
          src={iconUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => setBroken(true)}
        />
      </span>
    )
  }
  return (
    <span
      aria-hidden
      data-testid="item-avatar-initial"
      style={{ '--avatar-hue': avatarHue(name) } as React.CSSProperties}
      className={cn(
        box,
        'border-transparent bg-[oklch(0.93_0.045_var(--avatar-hue))] text-[oklch(0.45_0.12_var(--avatar-hue))] text-xs font-semibold uppercase',
        'dark:bg-[oklch(0.33_0.06_var(--avatar-hue))] dark:text-[oklch(0.86_0.08_var(--avatar-hue))]',
      )}
    >
      {name.trim().charAt(0) || '?'}
    </span>
  )
}
