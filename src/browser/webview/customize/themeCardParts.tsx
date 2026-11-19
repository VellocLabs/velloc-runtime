import * as React from 'react'

import { cn } from '@/lib/utils'

import { useT } from '../i18n'
import { AVATAR_TINT, avatarHue } from './ItemAvatar'

/** The theme grid (F-35): three columns at full width, two and one by the section's own width. */
export const THEME_GRID = 'grid grid-cols-1 gap-3 @[36rem]:grid-cols-2 @[56rem]:grid-cols-3'

/** A look's picture, or the name's initial on its own tint when there is none to show. */
export function LookPreview({ name, url }: { name: string; url: string }) {
  const t = useT()
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => setBroken(false), [url])
  if (broken || !/^https?:\/\//.test(url)) {
    return (
      <div
        aria-hidden
        data-testid="customize-theme-preview-fallback"
        style={{ '--avatar-hue': avatarHue(name) } as React.CSSProperties}
        className={cn(
          'flex aspect-[16/10] w-full items-center justify-center text-2xl font-semibold uppercase',
          AVATAR_TINT,
        )}
      >
        {name.trim().charAt(0) || '?'}
      </div>
    )
  }
  return (
    <img
      data-testid="customize-theme-preview"
      src={url}
      alt={t('customize.themes.previewAlt', { name })}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="aspect-[16/10] w-full bg-background object-cover"
      onError={() => setBroken(true)}
    />
  )
}
