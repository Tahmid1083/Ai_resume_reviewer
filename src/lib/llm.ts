/**
 * LLM client — pluggable so the SAME code path runs in three places:
 *
 *   1. Sandbox preview      → z-ai-web-dev-sdk (no API key needed)
 *   2. Cloudflare Workers AI → env.AI binding (free tier, no API key needed)
 *   3. Any OpenAI-compatible API → set OPENAI_API_KEY (and optional OPENAI_BASE_URL)
 *
 * The route handler in `app/api/review/route.ts` calls `streamResumeReview()`
 * and pipes the resulting ReadableStream straight to the client as SSE.
 */

const SYSTEM_PROMPT = `You are a senior technical recruiter and resume coach with 10+ years
of experience at FAANG companies. You review resumes with brutal honesty
and concrete, actionable suggestions.

Analyse the resume text the user gives you and return STRICT JSON with this
exact shape — no prose, no markdown fences, nothing outside the JSON object:

{
  "score": <0-100 integer>,
  "axes": {
    "clarity": <0-100>,
    "impact": <0-100>,
    "atsFit": <0-100>,
    "brevity": <0-100>
  },
  "summary": "<2-3 sentence overall verdict>",
  "strengths": ["<specific strength>", "..."],
  "weaknesses": ["<specific weakness>", "..."],
  "rewrites": [
    { "original": "<the original bullet>", "improved": "<stronger bullet>" }
  ],
  "keywords": {
    "present": ["TypeScript", "..."],
    "missing":  ["Kubernetes", "..."]
  }
}

Rules:
- "score" must be a weighted average of the four axes.
- "rewrites" must quote actual text from the resume verbatim.
- Be specific. "Needs improvement" is useless; say exactly what and why.
- If the resume is too short or empty, return score 0 with a weakness saying so.`

export interface ResumeReview {
  score: number
  axes: { clarity: number; impact: number; atsFit: number; brevity: number }
  summary: string
  strengths: string[]
  weaknesses: string[]
  rewrites: { original: string; improved: string }[]
  keywords: { present: string[]; missing: string[] }
}

/** Build the user message for the LLM. */
function buildUserPrompt(resumeText: string): string {
  const trimmed = resumeText.trim()
  if (!trimmed) return 'Resume text is empty.'
  return `Review the following resume and return the JSON object:\n\n---\n${trimmed}\n---\n`
}

/**
 * Returns a ReadableStream of text chunks (Server-Sent-Events friendly).
 * Falls back gracefully across environments.
 */
export async function streamResumeReview(resumeText: string): Promise<{
  stream: ReadableStream<Uint8Array>
  provider: string
}> {
  const userPrompt = buildUserPrompt(resumeText)
  const messages = [
    { role: 'assistant' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: userPrompt },
  ]

  // 1. Try Cloudflare Workers AI binding (set up only when deployed on CF).
  if (process.env.CLOUDFLARE === '1' || process.env.CF_PAGES) {
    try {
      const { getBindings } = await import('./env')
      const bindings = await getBindings()
      if (bindings.AI) {
        return {
          stream: streamFromCFWorkersAI(bindings.AI, messages),
          provider: 'cloudflare-workers-ai',
        }
      }
    } catch {
      // ignore, fall through to next provider
    }
  }

  // 2. Try OpenAI-compatible API (user provides OPENAI_API_KEY).
  if (process.env.OPENAI_API_KEY) {
    return {
      stream: streamFromOpenAI(messages),
      provider: 'openai',
    }
  }

  // 3. Sandbox fallback: z-ai-web-dev-sdk.
  return {
    stream: await streamFromZAISdk(messages),
    provider: 'z-ai-web-dev-sdk',
  }
}

/* -------------------------------------------------------------------------- */
/* Provider 1: Cloudflare Workers AI                                          */
/* -------------------------------------------------------------------------- */

async function* streamFromCFWorkersAI(
  ai: Ai,
  messages: { role: string; content: string }[]
): AsyncGenerator<string> {
  const res = (await ai.run('@cf/meta/llama-3.1-8b-instruct' as any, {
    messages,
    stream: true,
  })) as any
  if (res && typeof res[Symbol.asyncIterator] === 'function') {
    for await (const chunk of res) {
      const text = chunk?.response ?? chunk?.delta?.response ?? ''
      if (text) yield text
    }
  } else if (typeof res?.response === 'string') {
    // Non-streaming fallback: chunk it manually to simulate streaming.
    const full = res.response
    const words = full.split(/(\s+)/)
    for (const w of words) {
      yield w
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Provider 2: OpenAI-compatible API                                          */
/* -------------------------------------------------------------------------- */

async function* streamFromOpenAI(
  messages: { role: string; content: string }[]
): AsyncGenerator<string> {
  const baseURL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini'
  const res = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.4,
      response_format: { type: 'json_object' },
    }),
  })
  if (!res.ok || !res.body) {
    throw new Error(`OpenAI error ${res.status}: ${await res.text()}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const t = line.trim()
      if (!t.startsWith('data:')) continue
      const data = t.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data)
        const delta = json.choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch {
        // partial line; ignore
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Provider 3: z-ai-web-dev-sdk (sandbox / dev)                               */
/* -------------------------------------------------------------------------- */

async function* streamFromZAISdk(
  messages: { role: string; content: string }[]
): AsyncGenerator<string> {
  const ZAI = (await import('z-ai-web-dev-sdk')).default
  const zai = await ZAI.create()
  const completion = await zai.chat.completions.create({
    messages,
    thinking: { type: 'disabled' },
    stream: true,
  } as any)

  // Case A: SDK returned a ReadableStream (when stream:true + SSE response).
  if (completion && typeof (completion as any).getReader === 'function') {
    const reader = (completion as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const data = t.slice(5).trim()
        if (data === '[DONE]') return
        try {
          const json = JSON.parse(data)
          const delta =
            json?.choices?.[0]?.delta?.content ??
            json?.choices?.[0]?.message?.content ??
            ''
          if (delta) yield delta
        } catch {
          // ignore malformed chunk
        }
      }
    }
    return
  }

  // Case B: SDK returned an async iterator.
  if (completion && typeof (completion as any)[Symbol.asyncIterator] === 'function') {
    for await (const chunk of completion as any) {
      const text =
        chunk?.choices?.[0]?.delta?.content ??
        chunk?.choices?.[0]?.message?.content ??
        ''
      if (text) yield text
    }
    return
  }

  // Case C: SDK returned the full completion object — fake streaming.
  const full: string = (completion as any)?.choices?.[0]?.message?.content ?? ''
  if (!full) throw new Error('Empty LLM response from z-ai-web-dev-sdk')
  const tokens = full.split(/(\s+)/)
  for (const t of tokens) {
    yield t
    // Small delay so streaming is visible in the UI.
    await new Promise((r) => setTimeout(r, 12))
  }
}

/** Convert an async generator into a ReadableStream of UTF-8 bytes. */
function generatorToStream(gen: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await gen.next()
        if (done) {
          controller.close()
        } else {
          controller.enqueue(encoder.encode(value))
        }
      } catch (err) {
        controller.error(err)
      }
    },
    cancel() {
      gen.return(undefined)
    },
  })
}

/** Wrap an async generator into a SSE-encoded ReadableStream. */
async function wrapGenAsSSE(gen: AsyncGenerator<string>): Promise<ReadableStream<Uint8Array>> {
  const wrapped: AsyncGenerator<string> = (async function* () {
    for await (const chunk of gen) {
      // SSE: each "data:" line followed by \n\n
      const safe = chunk.replace(/\r\n/g, '\n').replace(/\n\n/g, '\n')
      yield `data: ${JSON.stringify(safe)}\n\n`
    }
    yield `data: [DONE]\n\n`
  })()
  return generatorToStream(wrapped)
}

// Make the helper available to the route.
;(streamFromZAISdk as any)._wrap = wrapGenAsSSE

export async function streamResumeReviewSSE(resumeText: string): Promise<{
  stream: ReadableStream<Uint8Array>
  provider: string
}> {
  // Use the same generator → SSE wrapper for every provider.
  const userPrompt = buildUserPrompt(resumeText)
  const messages = [
    { role: 'assistant' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: userPrompt },
  ]

  let gen: AsyncGenerator<string>
  let provider: string

  if (process.env.CLOUDFLARE === '1' || process.env.CF_PAGES) {
    try {
      const { getBindings } = await import('./env')
      const bindings = await getBindings()
      if (bindings.AI) {
        gen = streamFromCFWorkersAI(bindings.AI, messages)
        provider = 'cloudflare-workers-ai'
      } else if (process.env.OPENAI_API_KEY) {
        gen = streamFromOpenAI(messages)
        provider = 'openai'
      } else {
        gen = await streamFromZAISdk(messages)
        provider = 'z-ai-web-dev-sdk'
      }
    } catch {
      gen = await streamFromZAISdk(messages)
      provider = 'z-ai-web-dev-sdk'
    }
  } else if (process.env.OPENAI_API_KEY) {
    gen = streamFromOpenAI(messages)
    provider = 'openai'
  } else {
    gen = await streamFromZAISdk(messages)
    provider = 'z-ai-web-dev-sdk'
  }

  return { stream: await wrapGenAsSSE(gen), provider }
}
