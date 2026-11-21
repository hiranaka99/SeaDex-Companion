import { randomUUID } from 'node:crypto'
import type { DownloadProtocol } from '../shared/download-contracts.js'

/**
 * Server-side submission plans. The browser keeps only selections and a plan ID;
 * units, destinations and acknowledgements are recomputed from current state at
 * acceptance. Plans are memory-only on purpose — a restart expires unsubmitted
 * reviews, and nothing here may contain keys or authenticated NZB URLs.
 */
export interface StoredPlanSelection { key: string; release: number; identity?: string; protocol: DownloadProtocol }

export interface StoredPlan {
  id: string
  created_at: number
  expires_at: number
  config_generation: number
  selections: StoredPlanSelection[]
  requires_whole_ack: boolean
  requires_space_ack: boolean
}

const PLAN_TTL_MS = 15 * 60_000
const PLAN_LIMIT = 64

const plans = new Map<string, StoredPlan>()

export function putPlan(input: Omit<StoredPlan, 'id' | 'created_at' | 'expires_at'>): StoredPlan {
  const now = Date.now()
  for (const [id, plan] of plans) if (plan.expires_at <= now) plans.delete(id)
  while (plans.size >= PLAN_LIMIT) plans.delete(plans.keys().next().value as string)
  const plan: StoredPlan = { ...input, id: randomUUID(), created_at: now, expires_at: now + PLAN_TTL_MS }
  plans.set(plan.id, plan)
  return plan
}

export function getPlan(id: string): StoredPlan | null {
  const plan = plans.get(id)
  if (!plan) return null
  if (plan.expires_at <= Date.now()) { plans.delete(id); return null }
  return plan
}

/** Retrieves and burns a plan so a confirmation can never be replayed. */
export function consumePlan(id: string): StoredPlan | null {
  const plan = getPlan(id)
  if (plan) plans.delete(id)
  return plan
}

/** Configuration changes invalidate every unsubmitted review. */
export function invalidatePlans(): void { plans.clear() }
