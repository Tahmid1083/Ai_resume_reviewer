/**
 * Database client — supports BOTH environments:
 *
 *   1. Local dev / sandbox:  plain PrismaClient + SQLite (file:./db/custom.db)
 *   2. Cloudflare Workers:   PrismaClient + @prisma/adapter-d1 (binding: DB)
 *
 * Why async? On Cloudflare, the D1 binding is only reachable via
 * `getCloudflareContext()` which is async. So we initialize the client lazily
 * behind a Promise. In local dev that Promise resolves immediately.
 *
 * Usage in routes:
 *   import { db, dbReady } from '@/lib/db'
 *   await dbReady                 // no-op in local dev, awaits bindings on CF
 *   const u = await db.usage.findUnique({ where: { ip } })
 */

import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaInit: Promise<PrismaClient> | undefined
}

async function createPrisma(): Promise<PrismaClient> {
  // Cloudflare Workers path
  if (process.env.CLOUDFLARE === '1' || process.env.CF_PAGES) {
    try {
      const { getCloudflareContext } = await import('@opennextjs/cloudflare/worker')
      const { PrismaD1 } = await import('@prisma/adapter-d1')
      const ctx = await getCloudflareContext()
      const d1 = (ctx as any).env?.DB as D1Database | undefined
      if (d1) {
        const adapter = new PrismaD1(d1)
        return new PrismaClient({ adapter })
      }
    } catch (e) {
      console.error('[db] D1 init failed, falling back to SQLite:', e)
    }
  }
  // Local dev path
  return new PrismaClient({ log: ['error', 'warn'] })
}

const ready: Promise<PrismaClient> =
  globalForPrisma.prismaInit ?? createPrisma()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prismaInit = ready
}

/** Resolves when the database client is ready to use. Await this in routes. */
export const dbReady: Promise<void> = ready.then(() => undefined)

let _db: PrismaClient | undefined
ready.then((p) => {
  _db = p
  if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = p
})

/**
 * `db` is the resolved PrismaClient instance. It is populated synchronously
 * in local dev and asynchronously on Cloudflare. Always `await dbReady`
 * once at the top of any route that uses `db`.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!_db) {
      throw new Error(
        '[db] PrismaClient not ready yet. Did you forget `await dbReady`?'
      )
    }
    return (_db as any)[prop]
  },
})
