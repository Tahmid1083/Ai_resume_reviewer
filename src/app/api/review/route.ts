/**
 * POST /api/review
 *
 * Body: { resume: string }
 *
 * 1. Validates input length.
 * 2. Checks rate limit (10/min/IP).
 * 3. Atomically consumes 1 credit.
 * 4. Streams the LLM response as SSE (data: "<chunk>"\n\n ... [DONE]).
 * 5. On LLM failure, refunds the credit and returns 502.
 * 6. After successful stream, persists the result + score.
 *
 * Sets headers:
 *   X-RateLimit-Remaining, X-RateLimit-Reset
 *   X-Credits-Remaining
 */

import { NextRequest } from 'next/server'
import { streamResumeReviewSSE } from '@/lib/llm'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'
import { consumeCredit, refundCredit, recordReview, FREE_CREDITS } from '@/lib/usage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RESUME_CHARS = 12000

export async function POST(req: NextRequest) {
  let body: { resume?: string } = {}
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const resume = (body.resume || '').trim()
  if (!resume) {
    return Response.json({ error: 'Resume text is required.' }, { status: 400 })
  }
  if (resume.length > MAX_RESUME_CHARS) {
    return Response.json(
      { error: `Resume too long — keep it under ${MAX_RESUME_CHARS} chars.` },
      { status: 413 }
    )
  }

  const ip = getClientIP(req)

  // 1. Rate limit
  const rl = await checkRateLimit(ip)
  if (!rl.ok) {
    return new Response(
      JSON.stringify({
        error: 'Too many requests. Slow down.',
        resetAt: rl.resetAt,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(rl.resetAt),
          'Retry-After': String(Math.max(1, rl.resetAt - Math.floor(Date.now() / 1000))),
        },
      }
    )
  }

  // 2. Credit check (atomic)
  const credit = await consumeCredit(ip)
  if (!credit.ok) {
    return new Response(
      JSON.stringify({
        error: 'Out of free credits. Top up to continue.',
        freeCredits: FREE_CREDITS,
      }),
      {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'X-Credits-Remaining': '0',
          'X-RateLimit-Remaining': String(rl.remaining),
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      }
    )
  }

  // 3. Stream LLM response
  let result: { stream: ReadableStream<Uint8Array>; provider: string }
  try {
    result = await streamResumeReviewSSE(resume)
  } catch (err) {
    console.error('[/api/review] LLM init failed:', err)
    await refundCredit(ip)
    return Response.json(
      { error: 'LLM provider unavailable. Please try again.' },
      { status: 502 }
    )
  }

  // 4. Background: collect the full text as it streams so we can persist it.
  const [streamForClient, streamForPersist] = result.stream.tee()
  const persistPromise = persistInBackground(streamForPersist, ip, resume)

  // Make sure the persist promise doesn't crash the request.
  persistPromise.catch((e) => console.error('[/api/review] persist failed:', e))

  return new Response(streamForClient, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-RateLimit-Remaining': String(rl.remaining),
      'X-RateLimit-Reset': String(rl.resetAt),
      'X-Credits-Remaining': String(credit.remaining),
      'X-LLM-Provider': result.provider,
    },
  })
}

/**
 * Reads the SSE stream back into a single string and saves it as a Review row.
 * Runs entirely in the background — never blocks the client response.
 */
async function persistInBackground(stream: ReadableStream<Uint8Array>, ip: string, resume: string) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let full = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    full += decoder.decode(value, { stream: true })
  }

  // Parse SSE: extract data: lines, ignore [DONE].
  const chunks: string[] = []
  for (const line of full.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (payload === '[DONE]') continue
    try {
      chunks.push(JSON.parse(payload))
    } catch {
      // ignore
    }
  }
  const combined = chunks.join('')
  if (!combined) return

  // Try to extract a score for fast indexing.
  let score: number | undefined
  try {
    const parsed = JSON.parse(combined)
    if (typeof parsed.score === 'number') score = parsed.score
  } catch {
    // not JSON; store as-is
  }

  await recordReview(ip, resume, combined, score)
}

/** GET — quick health/info endpoint. */
export async function GET() {
  return Response.json({
    ok: true,
    endpoint: '/api/review',
    method: 'POST',
    body: { resume: 'string' },
    limits: { maxResumeChars: MAX_RESUME_CHARS },
  })
}
