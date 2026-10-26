import * as React from 'react'

import { cn } from '@/lib/utils'

/** A plugin's or connector's icon, or its initial when it has none or the image fails. */
export function ItemAvatar({ name, iconUrl, className }: { name: string; iconUrl?: string; className?: string }) {
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => setBroken(false), [iconUrl])
  const box = cn('flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted', className)
  if (iconUrl && !broken) {
    return (
      <span className={box}>
        <img src={iconUrl} alt="" className="size-full object-contain" onError={() => setBroken(true)} />
      </span>
    )
  }
  return (
    <span aria-hidden className={cn(box, 'text-xs font-semibold uppercase text-muted-foreground')}>
      {name.trim().charAt(0) || '?'}
    </span>
  )
}
