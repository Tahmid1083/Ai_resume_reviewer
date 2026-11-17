/**
 * POST /api/upload
 *
 * Accepts multipart/form-data with a single file field named `file`.
 * Extracts plain text from PDF, DOCX, or TXT/MD files.
 *
 * Returns: { filename, text, chars, method }
 *
 * Limits:
 *   - Max file size: 5 MB
 *   - Max extracted text: 12,000 chars (matches the review route cap)
 *   - Rate limited: 10 uploads/min/IP (uses the same KV/in-memory limiter)
 */

import { NextRequest } from 'next/server'
import { checkRateLimit, getClientIP } from '@/lib/rate-limit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_FILE_BYTES = 5 * 1024 * 1024 // 5 MB
const MAX_TEXT_CHARS = 12000

const EXT_TO_METHOD: Record<string, string> = {
  pdf: 'pdf',
  docx: 'docx',
  doc: 'docx', // legacy .doc will likely fail; mammoth only supports .docx
  txt: 'text',
  md: 'text',
  markdown: 'text',
  rtf: 'text',
}

export async function POST(req: NextRequest) {
  const ip = getClientIP(req)

  // Rate limit
  const rl = await checkRateLimit(ip)
  if (!rl.ok) {
    return Response.json(
      { error: 'Too many uploads. Slow down.' },
      { status: 429, headers: { 'Retry-After': '60' } }
    )
  }

  // Parse multipart form
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return Response.json({ error: 'Expected multipart/form-data.' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return Response.json({ error: 'No file uploaded. Use field name "file".' }, { status: 400 })
  }
  if (file.size === 0) {
    return Response.json({ error: 'Uploaded file is empty.' }, { status: 400 })
  }
  if (file.size > MAX_FILE_BYTES) {
    return Response.json(
      { error: `File too large — max ${MAX_FILE_BYTES / 1024 / 1024} MB.` },
      { status: 413 }
    )
  }

  const name = file.name.toLowerCase()
  const ext = name.includes('.') ? name.split('.').pop()! : ''
  const method = EXT_TO_METHOD[ext]
  if (!method) {
    return Response.json(
      {
        error: `Unsupported file type ".${ext}". Supported: pdf, docx, txt, md.`,
      },
      { status: 415 }
    )
  }

  // Read file bytes
  const arrayBuf = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuf)

  // Extract
  let text = ''
  try {
    if (method === 'pdf') {
      text = await extractPdf(buffer)
    } else if (method === 'docx') {
      text = await extractDocx(buffer)
    } else {
      text = buffer.toString('utf-8')
    }
  } catch (err) {
    console.error('[/api/upload] extraction failed:', err)
    return Response.json(
      { error: 'Could not extract text from the file. Is it corrupted?' },
      { status: 422 }
    )
  }

  // Clean up + cap length
  text = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim()
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + '\n\n[...truncated...]'
  }
  if (!text) {
    return Response.json(
      { error: 'Extracted text is empty — the file may be a scanned image PDF.' },
      { status: 422 }
    )
  }

  return Response.json({
    filename: file.name,
    text,
    chars: text.length,
    method,
    rateLimit: { remaining: rl.remaining, resetAt: rl.resetAt },
  })
}

/** GET — quick info endpoint. */
export async function GET() {
  return Response.json({
    ok: true,
    endpoint: '/api/upload',
    method: 'POST',
    acceptedTypes: ['pdf', 'docx', 'txt', 'md'],
    maxSize: `${MAX_FILE_BYTES / 1024 / 1024} MB`,
  })
}

/* -------------------------------------------------------------------------- */
/* Extractors                                                                 */
/* -------------------------------------------------------------------------- */

async function extractPdf(buf: Buffer): Promise<string> {
  // Use pdfjs-dist directly with worker disabled.
  // pdf-parse v2 wraps pdfjs-dist but Turbopack can't resolve the worker file
  // at build time, so we go one level down and configure pdfjs ourselves.
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs')

  // Manually load the worker entry as a module — this is what runs the parsing
  // code. Setting workerSrc to '' and loading the worker module via side-effect
  // import makes pdfjs run the worker on the main thread (no separate file).
  try {
    await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
  } catch {
    // Some bundlers can't resolve the worker entry — fall through to disableWorker.
  }
  pdfjs.GlobalWorkerOptions.workerSrc = ''

  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buf),
    // Run on main thread — no separate worker file needed.
    disableWorker: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  })
  const doc = await loadingTask.promise
  try {
    let text = ''
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const pageText = content.items
        .map((item: any) => (typeof item.str === 'string' ? item.str : ''))
        .join(' ')
      text += pageText + '\n'
    }
    return text.trim()
  } finally {
    await doc.destroy()
  }
}

async function extractDocx(buf: Buffer): Promise<string> {
  const mammoth = await import('mammoth')
  // extractRawText gives plain text without HTML markup — ideal for LLM input.
  // Mammoth accepts { buffer: Buffer } or { path: string }.
  const result = await mammoth.extractRawText({ buffer: buf })
  return result.value || ''
}
