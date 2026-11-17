/**
 * Environment detection + Cloudflare binding accessor.
 *
 * - In the sandbox / local `next dev`, we use plain `process.env`.
 * - On Cloudflare Workers (deployed via @opennextjs/cloudflare), bindings live
 *   on the request context, accessed through `getCloudflareContext()`.
 *
 * This file exposes a single `getBindings()` helper so the rest of the app
 * doesn't have to care which environment it's in.
 */

type Bindings = {
  DB?: D1Database // Cloudflare D1
  RATE_LIMIT?: KVNamespace // Cloudflare KV
  AI?: Ai // Cloudflare Workers AI
}

let cachedBindings: Bindings | null = null

async function loadBindings(): Promise<Bindings> {
  // On Cloudflare: use @opennextjs/cloudflare's context helper.
  // The package isn't installed in local dev, so the dynamic import will fail
  // and we'll fall through to returning an empty object (no bindings).
  if (process.env.CLOUDFLARE === '1' || !!process.env.CF_PAGES) {
    try {
      // Use a string variable so the bundler doesn't try to resolve the module
      // at build time when @opennextjs/cloudflare isn't installed.
      const moduleName = '@opennextjs/cloudflare/worker'
      const mod = await import(/* @vite-ignore */ moduleName as any)
      const ctx = await mod.getCloudflareContext()
      return (ctx as any).env as Bindings
    } catch {
      // fall through
    }
  }
  // Local dev / sandbox: no bindings available.
  return {}
}

export async function getBindings(): Promise<Bindings> {
  if (!cachedBindings) cachedBindings = await loadBindings()
  return cachedBindings
}

export function isCloudflare(): boolean {
  return process.env.CLOUDFLARE === '1' || !!process.env.CF_PAGES
}
