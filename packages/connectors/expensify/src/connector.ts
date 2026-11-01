// Expensify connector (beta, read-only use): expense reports through the Integration Server
// (integrations.expensify.com/Integration-Server/doc). Credentials are a partnerUserID/partnerUserSecret pair the
// person makes at expensify.com/tools/integrations. They act as that person with the whole API, writes included
// (creating reports and expenses, changing policies), and can't be limited to reading: self-hosted only, like Lemon
// Squeezy. Aggregate only runs the two read jobs: a combinedReportData export ("file", no onFinish, so nothing is
// marked as exported) and the download of its file.
//
// A sync cycle: one page per date window (Expensify allows at most a year per export). The first sync reads two years
// as two windows; later ones read from four months before the last cycle began (reports approved or edited late), to
// today. Each page exports the window with the template (template.ts), downloads the file and maps it (map.ts).

import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, HttpClient, isRecord, isoDate, requireSecret, str, systemClock, type Clock, type ConnectorDeps } from '@agfn/connector-sdk'
import { mapCardExpense, mapReimbursableReport, PROVIDER, toExpense, type Expense } from './map.ts'
import { EXPORT_TEMPLATE, parseExport } from './template.ts'

export const API = 'https://integrations.expensify.com'
export const PATH = '/Integration-Server/ExpensifyIntegrations'

export interface ExpensifySecret {
  partnerUserID: string
  partnerUserSecret: string
}

export interface ExpensifyOptions {
  deps: ConnectorDeps
  /** Days read on the first sync. Default 730. */
  backfillDays?: number
  /** Days re-read before the last cycle's start. Default 120. */
  overlapDays?: number
  apiBase?: string
}

export const EXPENSIFY_FULL_ACCESS_WARNING =
  'Expensify’s partner credentials can’t be limited to reading, so they could also change this Expensify account. Aggregate only reads; keep them private and regenerate them in Expensify when you disconnect.'

interface Cursor {
  /** Date windows still to read, oldest first: [startDate, endDate]. */
  windows: Array<[string, string]>
  /** When this cycle began (YYYY-MM-DD). */
  started: string
  /** When the previous complete cycle began. */
  last: string | null
}

const isCursor = (v: unknown): v is Cursor =>
  isRecord(v) && Array.isArray(v.windows) && v.windows.every((w) => Array.isArray(w) && w.length === 2 && w.every((d) => typeof d === 'string')) && typeof v.started === 'string'
const isSecret = (v: unknown): v is ExpensifySecret => isRecord(v) && typeof v.partnerUserID === 'string' && typeof v.partnerUserSecret === 'string' && v.partnerUserSecret !== ''

export const MAPPING_VERSION = 1
const codec = cursorCodec<Cursor>(PROVIDER, MAPPING_VERSION, isCursor)
const DAY = 86_400_000
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)

/** Date windows of at most 364 days covering [from, to]. */
export function windows(from: string, to: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let s = from; s <= to; s = addDays(s, 365)) {
    const e = addDays(s, 364)
    out.push([s, e < to ? e : to])
  }
  return out
}

/**
 * Expensify answers errors as JSON { responseCode, responseMessage } (often with HTTP 200); a successful export
 * answers with the file name as plain text. 401/407: the credentials are wrong or were regenerated.
 */
export function classifyExpensify(status: number, body: unknown): ConnectorError | undefined {
  let j: unknown = body
  if (typeof body === 'string' && body.trim().startsWith('{')) {
    try {
      j = JSON.parse(body)
    } catch {
      j = undefined
    }
  }
  const code = isRecord(j) && typeof j.responseCode === 'number' ? j.responseCode : status >= 400 ? status : 200
  if (code === 200) return undefined
  const message = ((isRecord(j) ? str(j.responseMessage) : undefined) ?? `Expensify HTTP ${status}`).slice(0, 300)
  const opts = { provider: PROVIDER, status: code }
  if (code === 401 || code === 407) return new ConnectorError('auth', message, opts)
  if (code === 403) return new ConnectorError('auth', `Expensify didn't allow this read: ${message}`, opts)
  if (code === 429) return new ConnectorError('rate_limited', 'Expensify rate limit', { ...opts, retryAfterMs: 60_000 })
  if (code >= 500) return new ConnectorError('transient', message, opts)
  if (code === 410) return new ConnectorError('invalid_input', message, opts)
  return new ConnectorError('permanent', message, opts)
}

export function createExpensifyConnector(opts: ExpensifyOptions): Connector {
  const { deps } = opts
  const clock: Clock = deps.clock ?? systemClock
  const backfill = Math.max(1, opts.backfillDays ?? 730)
  const overlap = Math.max(0, opts.overlapDays ?? 120)
  const http = new HttpClient({
    provider: PROVIDER,
    baseUrl: opts.apiBase ?? API,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    clock,
    ...(deps.random ? { random: deps.random } : {}),
    // Documented: 5 requests per 10 seconds, 20 per minute.
    rateLimit: { perSecond: 0.3, burst: 2 },
    classifyError: ({ status, body }) => classifyExpensify(status, body),
  })

  /** One job; a JSON error in a 200 is still an error. */
  async function job(job: Record<string, unknown>, template?: string): Promise<string> {
    const res = await http.request<string>({
      method: 'POST',
      path: PATH,
      form: { requestJobDescription: JSON.stringify(job), ...(template ? { template } : {}) },
      responseType: 'text',
      // Both jobs only read; a retry exports or downloads again.
      idempotent: true,
    })
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
    const err = classifyExpensify(res.status, text)
    if (err) throw err
    return text
  }

  async function exportWindow(sec: ExpensifySecret, [startDate, endDate]: [string, string]): Promise<string> {
    const credentials = { partnerUserID: sec.partnerUserID, partnerUserSecret: sec.partnerUserSecret }
    const fileName = (
      await job(
        {
          type: 'file',
          credentials,
          onReceive: { immediateResponse: ['returnRandomFileName'] },
          inputSettings: { type: 'combinedReportData', filters: { startDate, endDate } },
          outputSettings: { fileExtension: 'txt' },
        },
        EXPORT_TEMPLATE,
      )
    ).trim()
    if (!fileName || fileName.startsWith('{') || /\s/.test(fileName)) throw new ConnectorError('transient', 'Expensify did not return an export file name', { provider: PROVIDER })
    return job({ type: 'download', credentials, fileName, fileSystem: 'integrationServer' })
  }

  async function mapFile(conn: ConnectionRef, text: string): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = []
    const reports = new Map<string, Expense[]>()
    for (const row of parseExport(text)) {
      const e = toExpense(row)
      if (!e) continue
      const rawRef = await deps.raw.put(conn.id, 'expensify.expense', e.id, row)
      if (!e.reimbursable) events.push(...mapCardExpense(e, conn.id, rawRef))
      else reports.set(e.reportID, [...(reports.get(e.reportID) ?? []), e])
    }
    for (const [id, list] of reports) {
      const rawRef = await deps.raw.put(conn.id, 'expensify.report', id, list)
      const bill = mapReimbursableReport(list, conn.id, rawRef)
      if (bill) events.push(bill)
    }
    return events
  }

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Expensify',
    group: 'spend',
    provides: ['invoices'],
    freshness: 'updates every few hours',
    auth: 'api_key',
    dataVersion: MAPPING_VERSION,
  }

  return {
    describe: () => description,

    async begin() {
      return {
        kind: 'api_key',
        label: 'Expensify partner credentials',
        helpUrl: 'https://www.expensify.com/tools/integrations/',
        placeholder: '',
        steps: [
          'Sign in to Expensify and open expensify.com/tools/integrations.',
          'Create credentials and copy the partnerUserID and partnerUserSecret (the secret is shown once).',
          'Paste both here.',
        ],
        permissions: ['Expensify doesn’t offer read-only credentials. Aggregate only reads your expense reports and never marks them as exported.'],
        fields: [
          { name: 'partnerUserID', label: 'partnerUserID' },
          { name: 'partnerUserSecret', label: 'partnerUserSecret', secret: true },
        ],
      }
    },

    async connect(input) {
      const partnerUserID = str(input.partnerUserID)?.trim()
      const partnerUserSecret = str(input.partnerUserSecret)?.trim()
      if (!partnerUserID || !partnerUserSecret) throw new ConnectorError('invalid_input', 'Paste the Expensify partnerUserID and partnerUserSecret.', { provider: PROVIDER, forUser: true })
      const secret: ExpensifySecret = { partnerUserID, partnerUserSecret }
      // One small export (the last week), so wrong credentials fail here rather than on the first sync.
      const today = isoDate(clock.now())
      await exportWindow(secret, [addDays(today, -7), today])
      return { secret, config: { displayName: 'Expensify', warnings: [EXPENSIFY_FULL_ACCESS_WARNING] } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const sec = requireSecret(PROVIDER, conn.secret, isSecret)
      const prev = codec.decode(cursor)
      const today = isoDate(clock.now())
      let s: Cursor
      if (prev && prev.windows.length) s = prev
      else {
        const from = prev?.last ? addDays(prev.last, -overlap) : addDays(today, -backfill)
        s = { windows: windows(from, today), started: today, last: prev?.last ?? null }
      }
      const [w, ...rest] = s.windows
      const events = w ? await mapFile(conn, await exportWindow(sec, w)) : []
      if (rest.length) return { events, cursor: codec.encode({ ...s, windows: rest }), hasMore: true }
      return { events, cursor: codec.encode({ windows: [], started: s.started, last: s.started }), hasMore: false }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const sec = requireSecret(PROVIDER, conn.secret, isSecret)
        const today = isoDate(clock.now())
        await exportWindow(sec, [today, today])
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
