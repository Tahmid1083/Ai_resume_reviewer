-- D1 schema for AI Resume Reviewer
-- Apply with: wrangler d1 execute resume-db --remote --file=prisma/migrations/init.sql

-- Table: Usage (anonymous usage tracking keyed by IP)
CREATE TABLE IF NOT EXISTS "Usage" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "ip" TEXT NOT NULL,
  "credits" INTEGER NOT NULL DEFAULT 5,
  "totalUsed" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Usage_ip_key" UNIQUE ("ip")
);

-- Table: Review (saved reviews for history)
CREATE TABLE IF NOT EXISTS "Review" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "usageId" TEXT NOT NULL,
  "resumeText" TEXT NOT NULL,
  "result" TEXT NOT NULL,
  "score" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Review_usageId_fkey" FOREIGN KEY ("usageId") REFERENCES "Usage" ("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "Review_usageId_idx" ON "Review"("usageId");
