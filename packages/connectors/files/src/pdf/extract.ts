// The text layer of a PDF statement, receipt or bill, read in a resource-capped worker thread. Scans (no text) and
// locked PDFs are told apart so the person gets a useful message; anything else that goes wrong is "unreadable".
import { Worker } from 'node:worker_threads'
import { linesToText, toLines, type PdfLine } from './lines.ts'
import type { WorkerInput, WorkerOutput } from './worker.ts'

export const PDF_LIMITS = { maxPages: 60, maxChars: 2_000_000, textChars: 60_000, heapMb: 256, timeoutMs: 10_000 }

export type PdfText =
  | { status: 'text'; pages: number; lines: PdfLine[]; text: string; truncated: boolean }
  /** No text layer at all: a scan or a photo saved as PDF. */
  | { status: 'scanned'; pages: number }
  /** Needs a password to open. We never ask for one. */
  | { status: 'locked' }
  | { status: 'unreadable'; reason: string }

export async function extractPdfText(bytes: Uint8Array, limits: Partial<typeof PDF_LIMITS> = {}): Promise<PdfText> {
  const l = { ...PDF_LIMITS, ...limits }
  const out = await inWorker({ bytes, maxPages: l.maxPages, maxChars: l.maxChars }, l)
  if (out.status === 'locked') return out
  if (out.status === 'failed') return { status: 'unreadable', reason: out.reason }
  const lines = toLines(out.runs)
  if (!lines.length) return { status: 'scanned', pages: out.pages }
  const { text, truncated } = linesToText(lines, l.textChars)
  return { status: 'text', pages: out.pages, lines, text, truncated: truncated || out.truncated }
}

function inWorker(input: WorkerInput, l: typeof PDF_LIMITS): Promise<WorkerOutput> {
  return new Promise((resolve) => {
    let done = false
    const finish = (o: WorkerOutput) => {
      if (done) return
      done = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(o)
    }
    // A copy, so the caller's buffer is never detached or shared with the worker.
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: { ...input, bytes: input.bytes.slice() },
      resourceLimits: { maxOldGenerationSizeMb: l.heapMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true,
      stderr: true,
    })
    const timer = setTimeout(() => finish({ status: 'failed', reason: 'too complex to read' }), l.timeoutMs)
    worker.once('message', (m: WorkerOutput) => finish(m))
    worker.once('error', (err) => finish({ status: 'failed', reason: /memory|heap/i.test(String(err)) ? 'too complex to read' : 'not a readable PDF' }))
    worker.once('exit', () => finish({ status: 'failed', reason: 'not a readable PDF' }))
  })
}
