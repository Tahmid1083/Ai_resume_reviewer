/**
 * Rate limiting — sliding window counter.
 *
 * - On Cloudflare: uses the KV namespace bound as RATE_LIMIT.
 * - Locally: falls back to an in-memory Map (per-process, resets on restart).
 *
 * Limits are deliberately generous for a portfolio demo:
 *   10 reviews per minute per IP.
 *
 * Each check returns { ok, remaining, resetAt } so the route can set
 * X-RateLimit-* headers for good citizen clients.
 */

const WINDOW_SECONDS = 60
const MAX_REQUESTS = 10

type RateLimitResult = {
  ok: boolean
  remaining: number
  resetAt: number // unix seconds
}

// In-memory fallback store: Map<ip, { count, expiresAt }>
const memStore = new Map<string, { count: number; expiresAt: number }>()

export async function checkRateLimit(ip: string): Promise<RateLimitResult> {
  let kv: KVNamespace | null = null
  try {
    if (process.env.CLOUDFLARE === '1' || process.env.CF_PAGES) {
      const { getBindings } = await import('./env')
      const bindings = await getBindings()
      kv = bindings.RATE_LIMIT ?? null
    }
  } catch {
    kv = null
  }

  if (kv) {
    return checkWithKV(kv, ip)
  }
  return checkInMemory(ip)
}

async function checkWithKV(kv: KVNamespace, ip: string): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000)
  const key = `rl:${ip}:${Math.floor(now / WINDOW_SECONDS)}`
  const raw = await kv.get(key)
  const count = raw ? parseInt(raw, 10) : 0

  if (count >= MAX_REQUESTS) {
    return {
      ok: false,
      remaining: 0,
      resetAt: (Math.floor(now / WINDOW_SECONDS) + 1) * WINDOW_SECONDS,
    }
  }

  // Increment and store with TTL = window length.
  await kv.put(key, String(count + 1), {
    expirationTtl: WINDOW_SECONDS,
  })

  return {
    ok: true,
    remaining: MAX_REQUESTS - count - 1,
    resetAt: (Math.floor(now / WINDOW_SECONDS) + 1) * WINDOW_SECONDS,
  }
}

function checkInMemory(ip: string): RateLimitResult {
  const now = Math.floor(Date.now() / 1000)
  const existing = memStore.get(ip)

  if (!existing || existing.expiresAt <= now) {
    const expiresAt = now + WINDOW_SECONDS
    memStore.set(ip, { count: 1, expiresAt })
    return { ok: true, remaining: MAX_REQUESTS - 1, resetAt: expiresAt }
  }

  if (existing.count >= MAX_REQUESTS) {
    return { ok: false, remaining: 0, resetAt: existing.expiresAt }
  }

  existing.count += 1
  return {
    ok: true,
    remaining: MAX_REQUESTS - existing.count,
    resetAt: existing.expiresAt,
  }
}

/** Best-effort IP extraction, works on both Next.js dev and Cloudflare. */
export function getClientIP(req: Request): string {
  const headers = req.headers
  const xff = headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const realIp = headers.get('x-real-ip')
  if (realIp) return realIp.trim()
  const cfIp = headers.get('cf-connecting-ip')
  if (cfIp) return cfIp.trim()
  return 'unknown'
}
