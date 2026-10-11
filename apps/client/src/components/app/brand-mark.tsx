import { GalleryVerticalEndIcon } from 'lucide-react'

import { brandAssetUrl, useBranding } from '#/lib/branding'

/** The square mark: the uploaded icon, or a neutral glyph in the accent colour. */
export function BrandIcon({ className = 'size-6' }: { className?: string }) {
  const icon = useBranding((s) => s.icon)
  if (icon) {
    return (
      <img
        src={brandAssetUrl(icon)}
        alt=""
        className={`shrink-0 rounded-md object-contain ${className}`}
      />
    )
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground ${className}`}
      aria-hidden="true"
    >
      <GalleryVerticalEndIcon className="size-[60%]" />
    </span>
  )
}

/**
 * The product as people should recognise it: the logo when there is one
 * (it usually contains the name), otherwise the icon and the name.
 */
export function BrandMark({ className }: { className?: string }) {
  const name = useBranding((s) => s.product_name)
  const logo = useBranding((s) => s.logo)
  if (logo) {
    return (
      <img
        src={brandAssetUrl(logo)}
        alt={name}
        className={`h-7 max-w-40 object-contain object-left ${className ?? ''}`}
      />
    )
  }
  return (
    <span
      className={`flex min-w-0 items-center gap-2 font-medium ${className ?? ''}`}
    >
      <BrandIcon />
      <span className="truncate">{name}</span>
    </span>
  )
}
