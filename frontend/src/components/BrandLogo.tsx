import type { ImgHTMLAttributes } from 'react'

export type BrandName = 'sonarr' | 'radarr' | 'qbittorrent' | 'discord'

interface Props extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'width' | 'height'> {
  name: BrandName
  size?: number
}

// Service names and link labels carry the accessible text; brand artwork is decorative.
export default function BrandLogo({ name, size = 20, ...props }: Props) {
  return (
    <img
      className={name === 'radarr' ? 'shrink-0 rounded-sm bg-white object-contain' : 'shrink-0 object-contain'}
      {...props}
      style={{ ...props.style, width: size, height: size }}
      src={`/brands/${name}.svg`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  )
}
