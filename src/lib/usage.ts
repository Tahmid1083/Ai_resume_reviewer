/**
 * Usage credits — atomic decrement + refund pattern.
 *
 * Free tier: 5 reviews per IP. Each successful review decrements by 1.
 * If the LLM fails after we deducted a credit, we refund it.
 */

import { db, dbReady } from './db'

export const FREE_CREDITS = 5
export const CREDITS_PER_REVIEW = 1

/** Get or create the Usage row for a given IP. */
export async function getOrCreateUsage(ip: string) {
  await dbReady
  const existing = await db.usage.findUnique({ where: { ip } })
  if (existing) return existing

  return db.usage.create({
    data: { ip, credits: FREE_CREDITS, totalUsed: 0 },
  })
}

/**
 * Atomically try to consume one credit.
 * Returns { ok, remaining } — ok=false means the user is out of credits.
 */
export async function consumeCredit(
  ip: string,
  amount: number = CREDITS_PER_REVIEW
): Promise<{ ok: boolean; remaining: number }> {
  await dbReady
  // findUnique inside a transaction is not supported in SQLite via Prisma
  // for the read-modify-write race, so we use an interactive transaction.
  try {
    return await db.$transaction(async (tx) => {
      const usage = await tx.usage.findUnique({ where: { ip } })
      if (!usage) {
        // Create on first sight.
        const created = await tx.usage.create({
          data: { ip, credits: FREE_CREDITS - amount, totalUsed: amount },
        })
        return { ok: created.credits >= 0, remaining: Math.max(0, created.credits) }
      }
      if (usage.credits < amount) {
        return { ok: false, remaining: usage.credits }
      }
      const updated = await tx.usage.update({
        where: { id: usage.id },
        data: {
          credits: usage.credits - amount,
          totalUsed: usage.totalUsed + amount,
        },
      })
      return { ok: true, remaining: updated.credits }
    })
  } catch (err) {
    console.error('[usage] consumeCredit failed:', err)
    return { ok: false, remaining: 0 }
  }
}

/** Refund a credit if the LLM call blew up after we charged the user. */
export async function refundCredit(ip: string, amount: number = CREDITS_PER_REVIEW) {
  await dbReady
  try {
    const usage = await db.usage.findUnique({ where: { ip } })
    if (!usage) return
    await db.usage.update({
      where: { id: usage.id },
      data: { credits: usage.credits + amount },
    })
  } catch (err) {
    console.error('[usage] refundCredit failed:', err)
  }
}

/** Persist a completed review for the history page. */
export async function recordReview(
  ip: string,
  resumeText: string,
  result: string,
  score?: number
) {
  await dbReady
  const usage = await db.usage.findUnique({ where: { ip } })
  if (!usage) return null
  return db.review.create({
    data: { usageId: usage.id, resumeText, result, score },
  })
}
