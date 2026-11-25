import type { IncomingMessage, ServerResponse } from 'node:http'

export interface RouteContext {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  /** Capture groups of a pattern route. */
  params: string[]
}

export interface Route {
  method: string
  path: string | RegExp
  /** Public routes answer without a session; every other route requires one. */
  access: 'public' | 'session'
  handle(context: RouteContext): Promise<void> | void
}

export function route(
  method: string,
  path: string | RegExp,
  handle: Route['handle'],
  access: Route['access'] = 'session',
): Route {
  return { method, path, access, handle }
}

/** The first route registered for the method and path, with any pattern captures. */
export function matchRoute(routes: Route[], method: string, path: string): { route: Route; params: string[] } | null {
  for (const candidate of routes) {
    if (candidate.method !== method) continue
    if (typeof candidate.path === 'string') {
      if (candidate.path === path) return { route: candidate, params: [] }
      continue
    }
    const match = candidate.path.exec(path)
    if (match) return { route: candidate, params: match.slice(1) }
  }
  return null
}
