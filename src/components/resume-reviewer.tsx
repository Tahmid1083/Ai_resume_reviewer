'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import {
  Sparkles,
  FileText,
  Zap,
  Shield,
  Gauge,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Wand2,
  Upload,
  Loader2,
  Paperclip,
} from 'lucide-react'

type Axes = { clarity: number; impact: number; atsFit: number; brevity: number }
type Review = {
  score: number
  axes: Axes
  summary: string
  strengths: string[]
  weaknesses: string[]
  rewrites: { original: string; improved: string }[]
  keywords: { present: string[]; missing: string[] }
}

const SAMPLE = `Jane Developer
Senior Frontend Engineer

EXPERIENCE
Senior Frontend Engineer, Acme Corp (2022 - present)
- Built stuff for the website
- Worked on the team
- Used JavaScript

Frontend Engineer, Beta Inc (2019 - 2022)
- Made pages
- Did some bugs

SKILLS
JavaScript, HTML, CSS, React`

/**
 * Tries to parse a streaming buffer into a Review object.
 * - Strips markdown fences (```json ... ```)
 * - Tolerates incomplete trailing content by slicing back to the last } or ]
 * - Returns null if not yet parseable.
 */
function tryParseReview(text: string): Review | null {
  let t = text.trim()
  // Strip ```json ... ``` fences (opening + closing).
  t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '')
  // If we're still mid-stream and the JSON is incomplete, try slicing to last }.
  if (!t.endsWith('}')) {
    const lastBrace = t.lastIndexOf('}')
    if (lastBrace > 0) t = t.slice(0, lastBrace + 1)
    else return null
  }
  try {
    const parsed = JSON.parse(t)
    if (parsed && typeof parsed.score === 'number') return parsed as Review
  } catch {
    return null
  }
  return null
}

export function ResumeReviewer() {
  const [resume, setResume] = useState('')
  const [streamingText, setStreamingText] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const [loading, setLoading] = useState(false)
  const [credits, setCredits] = useState<number | null>(null)
  const [provider, setProvider] = useState<string>('')
  const [uploading, setUploading] = useState(false)
  const [uploadedFilename, setUploadedFilename] = useState<string>('')
  const [isDragging, setIsDragging] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const fetchUsage = useCallback(async () => {
    try {
      const res = await fetch('/api/usage')
      if (res.ok) {
        const data = await res.json()
        setCredits(data.credits)
      }
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    fetchUsage()
  }, [fetchUsage])

  const handleSubmit = async () => {
    if (!resume.trim()) {
      toast.error('Paste some resume text first.')
      return
    }
    if (resume.length > 12000) {
      toast.error('Resume is too long (max 12,000 chars).')
      return
    }
    if (credits !== null && credits <= 0) {
      toast.error('Out of free credits. The demo resets on reload.')
      return
    }

    setLoading(true)
    setReview(null)
    setStreamingText('')
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        if (res.status === 402) toast.error('Out of free credits.')
        else if (res.status === 429) toast.error('Rate limit hit. Wait a minute.')
        else if (res.status === 413) toast.error('Resume too long.')
        else toast.error(err.error || 'Review failed.')
        setLoading(false)
        return
      }

      setProvider(res.headers.get('X-LLM-Provider') || '')
      const remaining = res.headers.get('X-Credits-Remaining')
      if (remaining !== null) setCredits(parseInt(remaining, 10))

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let full = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const payload = t.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const chunk = JSON.parse(payload)
            full += chunk
            setStreamingText(full)
            // Try live parse — render structured view as soon as JSON is valid.
            const parsed = tryParseReview(full)
            if (parsed) setReview(parsed)
          } catch {
            // ignore partial JSON in payload
          }
        }
      }

      // Final parse attempt with the complete buffer.
      const finalParsed = tryParseReview(full)
      if (finalParsed) setReview(finalParsed)

      toast.success('Review complete.')
    } catch (err: any) {
      if (err.name === 'AbortError') {
        toast.info('Cancelled.')
      } else {
        console.error(err)
        toast.error('Network error — check the console.')
      }
    } finally {
      setLoading(false)
      abortRef.current = null
      fetchUsage()
    }
  }

  const handleStop = () => {
    abortRef.current?.abort()
  }

  const handleSample = () => {
    setResume(SAMPLE)
  }

  const handleClear = () => {
    setResume('')
    setReview(null)
    setStreamingText('')
    setUploadedFilename('')
  }

  /** Upload a File to /api/upload and load the extracted text into the textarea. */
  const handleUploadFile = async (file: File) => {
    const allowed = ['pdf', 'docx', 'txt', 'md', 'markdown']
    const ext = file.name.toLowerCase().split('.').pop() || ''
    if (!allowed.includes(ext)) {
      toast.error(`Unsupported file type: .${ext}. Use PDF, DOCX, TXT, or MD.`)
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('File is larger than 5 MB.')
      return
    }

    setUploading(true)
    setUploadedFilename('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/upload', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Upload failed.')
        return
      }
      setResume(data.text)
      setReview(null)
      setStreamingText('')
      setUploadedFilename(data.filename)
      toast.success(`Extracted ${data.chars.toLocaleString()} chars from ${data.filename}.`)
    } catch (err) {
      console.error(err)
      toast.error('Upload failed — check the console.')
    } finally {
      setUploading(false)
      // Reset file input so the same file can be re-selected.
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  /** Triggered when the hidden file input changes. */
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) handleUploadFile(f)
  }

  /** Drag handlers for the textarea drop target. */
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!uploading) setIsDragging(true)
  }
  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) handleUploadFile(f)
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* Header */}
      <div className="mb-8 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight">
            <Sparkles className="h-7 w-7 text-primary" />
            AI Resume Reviewer
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Paste your resume. Get a structured, recruiter-style critique in seconds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="gap-1">
            <Zap className="h-3 w-3" />
            {credits === null ? '—' : `${credits} credits left`}
          </Badge>
          {provider && (
            <Badge variant="outline" className="gap-1 text-xs">
              <Gauge className="h-3 w-3" />
              {provider}
            </Badge>
          )}
        </div>
      </div>

      {/* Feature row */}
      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <FeatureCard icon={<Upload className="h-4 w-4" />} title="Upload PDF/DOCX">
          Drag &amp; drop your resume file.
        </FeatureCard>
        <FeatureCard icon={<Zap className="h-4 w-4" />} title="Streaming SSE">
          Token-by-token output via Server-Sent Events.
        </FeatureCard>
        <FeatureCard icon={<Shield className="h-4 w-4" />} title="Rate-limited">
          10 requests/min/IP via Cloudflare KV.
        </FeatureCard>
        <FeatureCard icon={<Gauge className="h-4 w-4" />} title="Usage credits">
          5 free reviews per IP, atomic decrement.
        </FeatureCard>
      </div>

      {/* Input */}
      <Card className="mb-6">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileText className="h-4 w-4" />
            Your resume
            {uploadedFilename && (
              <Badge variant="outline" className="ml-1 gap-1 text-xs font-normal">
                <Paperclip className="h-3 w-3" />
                {uploadedFilename}
              </Badge>
            )}
          </CardTitle>
          <div className="flex gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.markdown"
              className="hidden"
              onChange={handleFileInputChange}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || loading}
            >
              {uploading ? (
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
              ) : (
                <Upload className="mr-1 h-3 w-3" />
              )}
              Upload
            </Button>
            <Button size="sm" variant="ghost" onClick={handleSample}>
              Load sample
            </Button>
            <Button size="sm" variant="ghost" onClick={handleClear}>
              Clear
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative rounded-md transition-colors ${
              isDragging ? 'ring-2 ring-primary ring-offset-2' : ''
            }`}
          >
            {isDragging && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-primary/5 backdrop-blur-sm">
                <div className="flex flex-col items-center gap-2 text-sm font-medium text-primary">
                  <Upload className="h-6 w-6" />
                  Drop your resume (PDF, DOCX, TXT)
                </div>
              </div>
            )}
            <Textarea
              value={resume}
              onChange={(e) => setResume(e.target.value)}
              placeholder="Paste your resume, or drag & drop a PDF / DOCX / TXT file here..."
              className="min-h-[200px] resize-y font-mono text-sm"
              maxLength={12000}
              disabled={uploading}
            />
          </div>
          <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>{resume.length.toLocaleString()} / 12,000 chars</span>
            <div className="flex gap-2">
              {loading ? (
                <Button size="sm" variant="destructive" onClick={handleStop}>
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleSubmit}
                  disabled={!resume.trim() || (credits !== null && credits <= 0)}
                >
                  <Wand2 className="mr-1 h-4 w-4" />
                  Review my resume
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Output */}
      {(loading || review || streamingText) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Sparkles className="h-4 w-4" />
              {review ? 'Review' : 'Streaming...'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {review ? (
              <StructuredReview review={review} />
            ) : (
              <>
                <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  Generating structured review...
                </div>
                <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words font-mono">
                  {streamingText || <Skeleton className="h-32 w-full" />}
                </pre>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <footer className="mt-12 border-t pt-6 text-center text-xs text-muted-foreground">
        Built with Next.js 16 · Prisma + D1 · Cloudflare Workers · Streaming SSE
      </footer>
    </div>
  )
}

function FeatureCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-card p-3">
      <div className="rounded-md bg-primary/10 p-2 text-primary">{icon}</div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

function StructuredReview({ review }: { review: Review }) {
  const scoreColor = (s: number) =>
    s >= 80 ? 'text-emerald-600' : s >= 60 ? 'text-amber-600' : 'text-rose-600'
  const axes: { key: keyof Axes; label: string }[] = [
    { key: 'clarity', label: 'Clarity' },
    { key: 'impact', label: 'Impact' },
    { key: 'atsFit', label: 'ATS Fit' },
    { key: 'brevity', label: 'Brevity' },
  ]
  return (
    <div className="space-y-6">
      {/* Score + axes */}
      <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
        <div className="flex flex-col items-center justify-center rounded-lg border bg-muted/30 p-4">
          <div className={`text-4xl font-bold ${scoreColor(review.score)}`}>
            {review.score}
          </div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            overall score
          </div>
        </div>
        <div className="space-y-2">
          {axes.map((a) => (
            <div key={a.key}>
              <div className="mb-1 flex justify-between text-sm">
                <span>{a.label}</span>
                <span className={scoreColor(review.axes[a.key])}>
                  {review.axes[a.key]}
                </span>
              </div>
              <Progress value={review.axes[a.key]} className="h-2" />
            </div>
          ))}
        </div>
      </div>

      {/* Summary */}
      <div>
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Verdict
        </h3>
        <p className="text-sm leading-relaxed">{review.summary}</p>
      </div>

      {/* Strengths + weaknesses */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 flex items-center gap-1 text-sm font-semibold text-emerald-600">
            <CheckCircle2 className="h-4 w-4" /> Strengths
          </h3>
          <ul className="space-y-1 text-sm">
            {review.strengths.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-emerald-600">•</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-2 flex items-center gap-1 text-sm font-semibold text-rose-600">
            <AlertTriangle className="h-4 w-4" /> Weaknesses
          </h3>
          <ul className="space-y-1 text-sm">
            {review.weaknesses.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-rose-600">•</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Rewrites */}
      {review.rewrites?.length > 0 && (
        <>
          <Separator />
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Bullet rewrites
            </h3>
            <div className="space-y-3">
              {review.rewrites.map((r, i) => (
                <div key={i} className="rounded-lg border p-3 text-sm">
                  <p className="mb-1 line-through text-muted-foreground">{r.original}</p>
                  <p className="font-medium text-emerald-700 dark:text-emerald-400">
                    → {r.improved}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Keywords */}
      {review.keywords && (
        <>
          <Separator />
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-2 text-sm font-semibold">Keywords present</h3>
              <div className="flex flex-wrap gap-1">
                {review.keywords.present.map((k) => (
                  <Badge key={k} variant="secondary" className="text-xs">
                    {k}
                  </Badge>
                ))}
              </div>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">Keywords missing</h3>
              <div className="flex flex-wrap gap-1">
                {review.keywords.missing.map((k) => (
                  <Badge key={k} variant="outline" className="text-xs text-amber-700">
                    {k}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
