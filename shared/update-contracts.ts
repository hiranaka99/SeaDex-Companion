/**
 * - `in_app`: the release can replace the app inside the running container.
 * - `image_required`: the release changes the container itself; pull the new image.
 * - `unavailable`: this installation cannot update itself, or the package could not be read.
 */
export type UpdateInstallMode = 'in_app' | 'image_required' | 'unavailable'

/** An installed update that stopped before it finished starting, and the version that took over. */
export interface UpdateFailure {
  version: string
  restored: string
  reason: string
  at: string
}

export interface UpdateStatus {
  current: string
  /** Version of the app built into the running Docker image. */
  image: string
  /** Started by the image's launcher, which can apply in-app updates. */
  managed: boolean
  last_failure: UpdateFailure | null
}

export interface UpdateInfo extends UpdateStatus {
  latest: string | null
  url: string | null
  /** How the latest release can be installed; null when already up to date. */
  install: { mode: UpdateInstallMode; reasons: string[] } | null
}
