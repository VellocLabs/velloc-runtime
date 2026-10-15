import type { ImgHTMLAttributes } from 'react'

export const PRODUCT_LOGO_URL = `${import.meta.env.BASE_URL}product_logo_128.png`

export const PRODUCT_LOGO_IMG_MARKUP =
  `<img src="${PRODUCT_LOGO_URL}" alt="" style="width:1em;height:1em;display:block;" />`

export function ProductLogoIcon({
  className,
  alt = '',
  ...rest
}: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  return (
    <img
      src={PRODUCT_LOGO_URL}
      alt={alt}
      className={className}
      {...rest}
    />
  )
}
