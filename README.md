# AI Resume Reviewer

A focused AI SaaS utility built with **Next.js 16 + Cloudflare Workers**.
Paste a resume, get a structured, recruiter-style critique streamed token-by-token.

This is the project folder — deploy it on Cloudflare in ~15 minutes.

## What's inside

| Feature | Where | Notes |
| --- | --- | --- |
| **Resume upload** | `src/app/api/upload/route.ts` | Drag-and-drop or button. Extracts text from PDF, DOCX, TXT, MD. Max 5 MB. |
| **Streaming SSE** | `src/app/api/review/route.ts` | Server-Sent Events via a `ReadableStream`. Each token is a `data: "<chunk>"\n\n` line. |
| **Structured JSON output** | `src/lib/llm.ts` system prompt | Score + 4 axes + strengths/weaknesses + bullet rewrites + keyword gaps. |
| **Rate limiting** | `src/lib/rate-limit.ts` | Sliding window, 10 req/min/IP. KV on Cloudflare, in-memory locally. |
| **Usage credits** | `src/lib/usage.ts` | 5 free reviews per IP, atomic decrement + refund pattern. |
| **Pluggable LLM** | `src/lib/llm.ts` | Falls through: Cloudflare Workers AI → OpenAI-compatible → z-ai-web-dev-sdk. |
| **Prisma + D1** | `prisma/schema.prisma` + `src/lib/db.ts` | SQLite locally, D1 on Cloudflare (auto-detected). |

## Tech stack

- Next.js 16 (App Router, Turbopack)
- TypeScript 5, Tailwind CSS 4, shadcn/ui
- Prisma 6 + `@prisma/adapter-d1` (Cloudflare D1)
- `@opennextjs/cloudflare` to ship Next.js as a Worker
- Cloudflare KV for rate limit counters
- Cloudflare Workers AI (free) OR OpenAI-compatible API for the LLM
- `pdfjs-dist` (PDF), `mammoth` (DOCX) for resume file extraction

## Local development

```bash
bun install
cp .env.example .env       # adjust if needed
bun run db:push             # creates the local SQLite DB
bun run dev                 # http://localhost:3000
```

The sandbox preview uses `z-ai-web-dev-sdk` so you don't need an API key. In a real local environment, set `OPENAI_API_KEY` to use OpenAI instead.

## Deploy on Cloudflare

See **[DEPLOY.md](./DEPLOY.md)** for the full step-by-step guide. TL;DR:

```bash
# 1. Install Cloudflare tooling
bun add -D @opennextjs/cloudflare wrangler @prisma/adapter-d1

# 2. Create the bindings (one-time)
bun run cf:d1:create         # creates D1 database, prints the ID
bun run cf:kv:create         # creates KV namespace, prints the ID
# → paste both IDs into wrangler.jsonc

# 3. Apply the schema to D1
bun run cf:d1:migrate        # runs prisma/migrations/init.sql remotely

# 4. Set the secret (optional — Workers AI works without it)
wrangler secret put OPENAI_API_KEY

# 5. Deploy
bun run deploy:cf
```

## File map

```
.
├── prisma/
│   ├── schema.prisma          # Usage + Review models
│   └── migrations/init.sql    # raw SQL for D1
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── review/route.ts  # POST → streaming SSE
│   │   │   ├── upload/route.ts  # POST → extract text from PDF/DOCX/TXT
│   │   │   └── usage/route.ts   # GET → remaining credits
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── components/
│   │   ├── resume-reviewer.tsx  # the whole UI (upload, input, stream, structured output)
│   │   └── ui/                  # shadcn/ui primitives
│   └── lib/
│       ├── db.ts                # Prisma client (SQLite local / D1 on CF)
│       ├── env.ts               # Cloudflare binding accessor
│       ├── llm.ts               # 3-provider streaming LLM client
│       ├── rate-limit.ts        # KV-backed sliding window
│       └── usage.ts             # atomic credit decrement + refund
├── open-next.config.ts          # @opennextjs/cloudflare config
├── wrangler.jsonc               # Cloudflare Workers config (D1 + KV + AI)
├── next.config.ts               # standalone output, sharp disabled
└── package.json                 # scripts: preview:cf, deploy:cf, cf:d1:*, cf:kv:create
```

## How the streaming works

```
Browser ──POST /api/review──▶ Worker
                              │
                              ├─ rate-limit KV check (sliding window)
                              ├─ credit decrement (atomic, transactional)
                              ├─ LLM stream opened (CF Workers AI / OpenAI / z-ai)
                              ├─ each token → JSON.stringify → "data: ...\n\n"
                              └─ Response.body → ReadableStream piped to client
Browser ◀──chunked SSE────────┘
```

The browser's `fetch().body.getReader()` reads chunks, decodes them, appends to a
buffer, and tries to `JSON.parse` it after every token. As soon as the JSON is
valid, the UI swaps from "raw streaming text" to the structured card view.

## Adding Stripe for paid credits

Out of scope for this starter, but the hooks are already there:

1. Add `model Subscription { ... }` to `prisma/schema.prisma`.
2. Add `/api/stripe/webhook` route that increments `Usage.credits` on `checkout.session.completed`.
3. Replace the "Out of credits" 402 with a Stripe Checkout redirect.

## License

MIT — use it for your portfolio, your startup, whatever you want.
