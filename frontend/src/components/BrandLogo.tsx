import type { ImgHTMLAttributes } from 'react'

export type BrandName = 'sonarr' | 'radarr' | 'qbittorrent' | 'sabnzbd' | 'animetosho' | 'amenzb' | 'discord'

interface Props extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt' | 'width' | 'height'> {
  name: BrandName
  size?: number
  /** Seat the mark on a light tile so dark artwork (Radarr, AnimeTosho) stays legible on dark surfaces. */
  tile?: boolean
}

// Service names and link labels carry the accessible text; brand artwork is decorative.
const extensions: Partial<Record<BrandName, string>> = { animetosho: 'png', amenzb: 'png' }

export default function BrandLogo({ name, size = 20, tile = false, ...props }: Props) {
  const image = (
    <img
      className={tile ? 'shrink-0 rounded-sm object-contain' : name === 'radarr' ? 'shrink-0 rounded-sm bg-white object-contain' : name === 'amenzb' ? 'shrink-0 rounded-md object-contain' : 'shrink-0 object-contain'}
      {...props}
      style={{ ...props.style, width: size, height: size }}
      src={`/brands/${name}.${extensions[name] ?? 'svg'}`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  )
  if (!tile) return image
  const edge = size + 10
  return <span aria-hidden="true" className="inline-grid shrink-0 place-items-center rounded-lg bg-ink" style={{ width: edge, height: edge }}>{image}</span>
}
