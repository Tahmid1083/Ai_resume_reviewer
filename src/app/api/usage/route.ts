/**
 * GET /api/usage
 *
 * Returns the caller's remaining credits + past review count.
 * Identified by IP fingerprint (no auth in this starter).
 *
 * In production you'd scope this to the authenticated user.
 */

import { NextRequest } from 'next/server'
import { getClientIP } from '@/lib/rate-limit'
import { getOrCreateUsage, FREE_CREDITS } from '@/lib/usage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const ip = getClientIP(req)
  const usage = await getOrCreateUsage(ip)
  return Response.json({
    ip,
    credits: usage.credits,
    totalUsed: usage.totalUsed,
    freeCredits: FREE_CREDITS,
  })
}
