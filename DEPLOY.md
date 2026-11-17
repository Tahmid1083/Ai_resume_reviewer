# Deploying on Cloudflare Workers

This guide walks you through deploying the AI Resume Reviewer to Cloudflare.
You'll end up with a Next.js app running on Cloudflare's edge network, backed
by D1 (SQLite) and KV for rate limiting.

**Prerequisites**
- A Cloudflare account (free tier is enough).
- Node.js 20+ and Bun installed locally.
- The Cloudflare CLI authenticated: `npx wrangler login`.

---

## Step 1 — Install the Cloudflare tooling

The starter lists these as devDependencies, so a single install covers them:

```bash
bun install
# or: npm install
```

This installs:
- `@opennextjs/cloudflare` — builds Next.js into a Worker bundle
- `wrangler` — Cloudflare's CLI
- `@prisma/adapter-d1` — lets Prisma talk to a D1 binding

## Step 2 — Create the Cloudflare resources

### 2a. D1 database

```bash
bun run cf:d1:create
```

This runs `wrangler d1 create resume-db`. The output looks like:

```
✅ Successfully created DB 'resume-db'
[[d1_databases]]
binding = "DB"
database_name = "resume-db"
database_id = "abcd1234-5678-..."   ← copy this ID
```

Open `wrangler.jsonc` and replace `REPLACE_WITH_YOUR_D1_ID` with the printed ID.

### 2b. KV namespace (for rate limiting)

```bash
bun run cf:kv:create
```

Output:

```
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "efgh5678-..."   ← copy this ID
```

Replace `REPLACE_WITH_YOUR_KV_ID` in `wrangler.jsonc` with the printed ID.

### 2c. Workers AI

Workers AI is enabled automatically by the `ai` binding in `wrangler.jsonc`.
No setup needed. The LLM client in `src/lib/llm.ts` will use it automatically
when `CLOUDFLARE=1` is set (which `wrangler.jsonc` does for you via `vars`).

## Step 3 — Apply the database schema

```bash
bun run cf:d1:migrate          # apply to remote D1
bun run cf:d1:migrate:local    # also apply to local D1 for `wrangler dev`
```

This runs `prisma/migrations/init.sql` against your D1 database, creating the
`Usage` and `Review` tables.

## Step 4 — (Optional) Configure OpenAI instead of Workers AI

If you'd rather use OpenAI's GPT models, set these as secrets:

```bash
wrangler secret put OPENAI_API_KEY
# paste your sk-... key when prompted

wrangler secret put OPENAI_MODEL      # optional, defaults to gpt-4o-mini
wrangler secret put OPENAI_BASE_URL   # optional, defaults to https://api.openai.com/v1
```

Leave them unset to keep using Cloudflare Workers AI (free, no API key).

## Step 5 — Build and deploy

```bash
bun run deploy:cf
```

This runs:
1. `opennextjs-cloudflare-build` — builds Next.js into a Worker bundle in `.open-next/`.
2. `wrangler deploy` — uploads the bundle to Cloudflare.

When it finishes you'll get a URL like `https://ai-resume-reviewer.<your-subdomain>.workers.dev`.

## Step 6 — (Optional) Custom domain

In the Cloudflare dashboard:
1. Go to **Workers & Pages → ai-resume-reviewer → Settings → Domains & Routes**.
2. Click **Add Custom Domain** and enter your domain (must be on Cloudflare DNS).
3. Cloudflare provisions the TLS cert automatically.

## Step 7 — Verify

```bash
curl https://your-worker.workers.dev/api/usage
# → {"ip":"...","credits":5,"totalUsed":0,"freeCredits":5}

curl -N -X POST https://your-worker.workers.dev/api/review \
  -H "Content-Type: application/json" \
  -d '{"resume":"Jane Doe\nSoftware Engineer\n- Built things"}'
# → data: "{\n"
#   data: " \"score\":"
#   ...
#   data: [DONE]
```

---

## How the pieces fit together

```
┌────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (Next.js App Router via @opennextjs)    │
│                                                            │
│  GET  /              → page.tsx (resume reviewer UI)       │
│  GET  /api/usage     → reads D1.Usage by IP                │
│  POST /api/review    → rate-limit (KV) → credit check (D1) │
│                       → LLM stream (Workers AI / OpenAI)   │
│                       → SSE response → background persist  │
│                                                            │
│  Bindings:                                                 │
│    DB          → D1 database (resume-db)                   │
│    RATE_LIMIT  → KV namespace                              │
│    AI          → Workers AI                                │
│    ASSETS      → static assets from Next build             │
└────────────────────────────────────────────────────────────┘
```

## Local preview with `wrangler dev`

You can preview the production Worker locally before deploying:

```bash
bun run cf:d1:migrate:local     # apply schema to local D1
bun run preview:cf              # opennextjs-cloudflare-build && wrangler dev
```

This starts Wrangler's local Worker runtime with all bindings simulated.

## Common issues

**`Error: Cannot find module '@opennextjs/cloudflare/worker'`**
You're running in a non-Cloudflare environment (e.g. plain `next dev`). The
dynamic import in `src/lib/env.ts` is supposed to be wrapped in try/catch —
if you see this, make sure the import is dynamic, not static.

**`PrismaClient not ready yet`**
A route is calling `db.X` before `dbReady` resolved. Add `await dbReady` at
the top of the route handler (the starter already does this in `usage.ts`).

**`D1: SQLITE_ERROR: no such table: Usage`**
You haven't applied the migration. Run `bun run cf:d1:migrate` (remote) or
`bun run cf:d1:migrate:local` (for `wrangler dev`).

**`wrangler deploy` fails with "database_id"**
You forgot to paste the D1 ID from Step 2a into `wrangler.jsonc`.

**Streaming returns only `[DONE]`**
The LLM provider returned an empty stream. Check `wrangler tail` for errors.
Workers AI may rate-limit on the free plan — switch to OpenAI if so.

## Cost expectations (Cloudflare free tier)

- D1: 5M reads / 100K writes per day — plenty for a portfolio demo.
- KV: 100K reads / 1K writes per day.
- Workers AI: 10K Neurons/day free (≈ 100–500 reviews depending on model).
- Workers requests: 100K/day.

You can run ~100–500 reviews/day for free. Beyond that, upgrade to Workers Paid
($5/month) for 10M requests + D1 paid + KV paid.

## What to swap for a real production launch

- Replace IP-based usage tracking with authenticated users (Clerk or NextAuth).
- Replace `Usage.credits` freebie with Stripe-bought credit packs.
- Add observability: Logflare or Cloudflare Workers Analytics.
- Add a custom domain + Cloudflare Cache Reserve for static assets.
