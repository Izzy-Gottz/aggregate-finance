// Runs inside a worker_threads Worker (extract.ts) with a heap cap and a wall clock, so a hostile or huge PDF can
// only take this thread down. Text only: no rendering, no fonts, no scripts, nothing fetched.
//
// pdfjs-dist 6 has no eval path left (the CVE-2024-4367 font bug in < 4.2.67 was `new Function` on font data); the
// options below still turn off everything we don't use, so nothing outside the text layer is ever run or loaded.
import { parentPort, workerData } from 'node:worker_threads'
import type { PdfRun } from './lines.ts'

export interface WorkerInput {
  bytes: Uint8Array
  maxPages: number
  maxChars: number
}

export type WorkerOutput =
  | { status: 'ok'; pages: number; pagesRead: number; runs: PdfRun[]; truncated: boolean }
  | { status: 'locked' }
  | { status: 'failed'; reason: string }

async function run(input: WorkerInput): Promise<WorkerOutput> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({
    data: input.bytes,
    stopAtErrors: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    useWasm: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    maxImageSize: 0,
    verbosity: 0,
    // An empty password: owner-only restrictions (no printing/copying) open; a user password does not.
    password: '',
  })
  let doc: Awaited<typeof task.promise>
  try {
    doc = await task.promise
  } catch (err) {
    if ((err as { name?: string }).name === 'PasswordException') return { status: 'locked' }
    return { status: 'failed', reason: 'not a readable PDF' }
  }
  try {
    const runs: PdfRun[] = []
    let chars = 0
    let full = false
    const pagesRead = Math.min(doc.numPages, input.maxPages)
    for (let p = 1; p <= pagesRead && !full; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false })
      for (const item of content.items) {
        if (!('str' in item) || !item.str) continue
        const [a, b, c, d, e, f] = item.transform as number[]
        runs.push({ page: p, x: e!, y: f!, width: item.width, height: Math.hypot(c!, d!) || Math.hypot(a!, b!) || item.height, text: item.str.slice(0, 2000) })
        chars += item.str.length
        if (chars > input.maxChars) {
          full = true
          break
        }
      }
      page.cleanup()
    }
    return { status: 'ok', pages: doc.numPages, pagesRead, runs, truncated: full || doc.numPages > pagesRead }
  } catch {
    return { status: 'failed', reason: 'the PDF is damaged' }
  } finally {
    await task.destroy().catch(() => undefined)
  }
}

if (parentPort) {
  run(workerData as WorkerInput).then(
    (out) => parentPort!.postMessage(out),
    () => parentPort!.postMessage({ status: 'failed', reason: 'not a readable PDF' } satisfies WorkerOutput),
  )
}
