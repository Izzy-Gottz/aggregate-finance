// Shareable answer cards (launch plan, "Built-in viral loops"): one answer frozen at /a/<id> with an image for link
// previews. Ratios only unless the person turns amounts on; "A company" unless they turn the name on. A card starts as
// a draft (from the app, or an AI's share_answer) and goes live only when someone who manages the workspace publishes
// it; revoking makes the link 410 at once. The snapshot holds only what the card shows, never rows or account names.
//
// Numbers come from the same reader as the company drawer (runway and cash metrics, the 12-month cash trend), never
// from the browser or the AI. "Reconciled" means the figures are known and fresh and the company's data health is 0.

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Kysely } from 'kysely'
import type { FinanceReader, Money } from '@agfn/contracts'
import { nowIso, withBypass, type CoreTables } from '@agfn/db'
import { exponentOf } from '@agfn/core'
import { DbRateLimiter } from '@agfn/mcp'
import { financeFor } from './finance.ts'
import { cashTrend } from './routes/finance.ts'
import { badgeSnapshot, badgeWords, type BadgeField, type BadgeFigure } from './badge.ts'
import { factsFrom, lines, pnlOf, refusal, windows } from './roast.ts'
import type { Services } from './services.ts'

export type ShareKind = 'runway' | 'cash_trend' | 'roast' | 'hype' | 'badge'
/** 'badge' (badge.ts) only where the server turns badges on (AGFN_BADGES); the routes check. */
export const SHARE_KINDS: ShareKind[] = ['runway', 'cash_trend', 'roast', 'hype', 'badge']
/** What a card may show beyond ratios. Each is off unless the person turns it on. */
export interface ShareOpts {
  amounts: boolean
  name: boolean
  /** roast/hype: vendor names in the lines ("Slack" instead of "one software tool"). */
  vendors?: boolean
  /** badge: the figures it shows, each off unless turned on. */
  fields?: BadgeField[]
}

/** Exactly what a published card shows. Amounts and the company name are absent unless the person turned them on. */
export interface ShareSnapshot {
  kind: ShareKind
  /** The day the figures are as of (YYYY-MM-DD). */
  asOf: string
  reconciled: boolean
  /** The company's name, only when shown. */
  company?: string
  /** runway: whole months (rounded down), or null when the company isn't burning cash. */
  months?: number | null
  /** cash_trend: twelve month-end points scaled to 0…1 (a shape, no axis), and the change over the year. */
  points?: number[]
  changePct?: number | null
  /** Only when amounts are on: the cash figure, already formatted ("$1.2M"). */
  cash?: string
  /** roast/hype: the template lines (roast.ts), each filled with one figure the ledger made. Never AI text. */
  lines?: string[]
  /** badge: the figures it shows (bands and whole percents), which ones the owner chose, and the daily check. */
  badges?: BadgeFigure[]
  fields?: BadgeField[]
  /** badge: false when Aggregate couldn't vouch for the books at the last daily check ("Not current"). */
  current?: boolean
  checkedAt?: string
}

export interface ShareRow {
  id: string
  workspace_id: string
  entity_id: string
  created_by: string
  /** "app", or the AI client's name for a share_answer draft. */
  source: string
  kind: ShareKind
  status: 'draft' | 'live' | 'revoked'
  snapshot: string | null
  created_at: string
  published_at: string | null
  revoked_at: string | null
}

export class ShareError extends Error {
  readonly status: 404 | 409 | 422 | 429
  constructor(status: 404 | 409 | 422 | 429, message: string) {
    super(message)
    this.status = status
  }
}

/** Card creations per workspace per day (drafts count: an AI can't make thousands). */
export const SHARE_LIMIT = { count: 20, windowMs: 24 * 3600_000 }
/** 128 random bits, URL-safe: links can't be guessed or walked. */
export const newShareId = () => randomBytes(16).toString('base64url')

type S = Pick<Services, 'db' | 'ledger' | 'syncDeps' | 'permissions'>
const db = (s: S) => s.db as unknown as Kysely<CoreTables & { share_cards: ShareRow }>

// ---------- Figures ----------

export function compactMoney(m: Money): string {
  const v = Math.abs(m.minor / 10 ** exponentOf(m.currency))
  const [n, suffix] = v >= 1e9 ? [v / 1e9, 'B'] : v >= 1e6 ? [v / 1e6, 'M'] : v >= 1e4 ? [v / 1e3, 'K'] : [v, '']
  const digits = suffix && n < 10 ? 1 : 0
  let sym = ''
  try {
    sym = new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? ''
  } catch {
    sym = `${m.currency} `
  }
  return `${m.minor < 0 ? '−' : ''}${sym}${n.toFixed(digits).replace(/\.0$/, '')}${suffix}`
}

/** The figures for one company, as the app would show them now. Throws ShareError when the answer isn't known. */
export async function buildSnapshot(s: S, ws: string, entity: { id: string; name: string }, kind: ShareKind, opts: ShareOpts, now = new Date()): Promise<ShareSnapshot> {
  if (kind === 'badge') return badgeSnapshot(s, ws, entity, opts)
  const r: FinanceReader = financeFor(s).reader
  const scope = { workspaceId: ws, entityIds: [entity.id] }
  const [cash, health, runway] = await Promise.all([r.metric('cash', scope), r.metric('data_health', scope), kind === 'runway' ? r.metric('runway', scope) : Promise.resolve(null)])
  const fresh = (st: string | undefined) => !st || st === 'ok' || st === 'not_burning'
  const reconciled = fresh(cash.state) && !cash.staleSources.length && fresh(runway?.state) && health.value === 0
  const cashMoney = cash.value && typeof cash.value === 'object' ? (cash.value as Money) : null
  const snap: ShareSnapshot = { kind, asOf: String(cash.asOf).slice(0, 10), reconciled, ...(opts.name ? { company: entity.name } : {}) }
  if (opts.amounts) {
    if (!cashMoney) throw new ShareError(422, 'Cash isn’t known yet for this company, so there’s nothing to share.')
    snap.cash = compactMoney(cashMoney)
  }
  if (kind === 'roast' || kind === 'hype') {
    delete snap.cash // no amounts on these, ever
    const months = windows(snap.asOf)
    const rows = await r.searchTransactions(scope, { from: months.nowFrom, to: months.to, limit: 10_000 })
    const [rw, pnlNow, pnlBefore] = await Promise.all([
      r.metric('runway', scope),
      r.reports(scope, 'profit_and_loss', months.nowFrom, months.to, 'accrual'),
      r.reports(scope, 'profit_and_loss', months.from, months.beforeTo, 'accrual'),
    ])
    const pnl = { now: pnlOf(pnlNow[0]), before: pnlOf(pnlBefore[0]) }
    const facts = factsFrom(rows.rows, months, pnl, rw.state === 'not_burning' ? null : typeof rw.value === 'number' ? Math.floor(rw.value) : undefined)
    const no = refusal(kind, reconciled, facts)
    if (no) throw new ShareError(422, no)
    const said = lines(kind, facts, { names: !!opts.vendors })
    if (!said.length) throw new ShareError(422, kind === 'roast' ? 'Not enough spending yet to roast. Give it a month.' : 'Not enough history yet to cheer about. Give it a month.')
    snap.lines = said
    return snap
  }
  if (kind === 'runway') {
    if (runway!.state === 'not_burning') snap.months = null
    else if (typeof runway!.value === 'number') snap.months = Math.max(0, Math.floor(runway!.value))
    else throw new ShareError(422, runway!.state === 'not_enough_history' ? 'Runway needs two full months of history first.' : 'Runway isn’t known yet for this company.')
    return snap
  }
  const trend = await cashTrend(s, r, ws, entity.id, now)
  // The card says "over 12 months", so it needs all twelve: a younger company's trend starts later (cashTrend).
  if (trend.length < 12 || !cashMoney) throw new ShareError(422, 'There isn’t a year of cash history to share yet.')
  const lo = Math.min(...trend)
  const hi = Math.max(...trend)
  snap.points = trend.map((v) => (hi === lo ? 0.5 : Math.round(((v - lo) / (hi - lo)) * 1000) / 1000))
  const first = trend[0]!
  snap.changePct = first > 0 ? Math.round(((trend[trend.length - 1]! - first) / first) * 100) : null
  return snap
}

// ---------- Store ----------

async function entityFor(s: S, ws: string, personId: string, entityId: string): Promise<{ id: string; name: string }> {
  const visible = await s.permissions.entitiesFor(ws, personId)
  const e = visible.find((x) => x.id === entityId)
  // Not visible and not existing look the same.
  if (!e) throw new ShareError(404, 'That company was not found.')
  if (e.kind !== 'company') throw new ShareError(422, 'Cards are for companies.')
  const can = await s.permissions.can({ kind: 'person', personId, workspaceId: ws }, 'view', e.id, 'balances')
  if (!can) throw new ShareError(404, 'That company was not found.')
  return { id: e.id, name: e.name }
}

/** A new draft. Nothing is public until publishShare. Counts toward the workspace's daily limit. */
export async function draftShare(s: S, i: { workspaceId: string; personId: string; entityId: string; kind: ShareKind; source: string }, nowMs = Date.now()): Promise<{ id: string }> {
  if (!SHARE_KINDS.includes(i.kind)) throw new ShareError(422, 'Pick runway, cash_trend, roast, hype or badge.')
  await entityFor(s, i.workspaceId, i.personId, i.entityId)
  const wait = await new DbRateLimiter(s.db as never).hit(`share:ws:${i.workspaceId}`, SHARE_LIMIT.count, SHARE_LIMIT.windowMs, nowMs)
  if (wait > 0) throw new ShareError(429, 'That’s a lot of cards for one day. Try again tomorrow.')
  const id = newShareId()
  await db(s)
    .insertInto('share_cards')
    .values({ id, workspace_id: i.workspaceId, entity_id: i.entityId, created_by: i.personId, source: i.source.slice(0, 80) || 'app', kind: i.kind, status: 'draft', snapshot: null, created_at: nowIso(), published_at: null, revoked_at: null })
    .execute()
  return { id }
}

async function ownRow(s: S, ws: string, id: string): Promise<ShareRow> {
  const row = await db(s).selectFrom('share_cards').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()
  if (!row) throw new ShareError(404, 'That card was not found.')
  return row as ShareRow
}

/** What the card would show if published now (the confirm sheet's preview). Never stored. */
export async function previewShare(s: S, ws: string, personId: string, id: string, opts: ShareOpts): Promise<ShareSnapshot> {
  const row = await ownRow(s, ws, id)
  if (row.status === 'revoked') throw new ShareError(409, 'This card was revoked.')
  return buildSnapshot(s, ws, await entityFor(s, ws, personId, row.entity_id), row.kind, opts)
}

/** The person's act: freeze the figures now and make the link work. */
export async function publishShare(s: S, ws: string, personId: string, id: string, opts: ShareOpts): Promise<ShareSnapshot> {
  const row = await ownRow(s, ws, id)
  if (row.status !== 'draft') throw new ShareError(409, row.status === 'live' ? 'This card is already live.' : 'This card was revoked.')
  const snap = await buildSnapshot(s, ws, await entityFor(s, ws, personId, row.entity_id), row.kind, opts)
  await db(s).updateTable('share_cards').set({ status: 'live', snapshot: JSON.stringify(snap), published_at: nowIso() }).where('workspace_id', '=', ws).where('id', '=', id).where('status', '=', 'draft').execute()
  return snap
}

/** Ends the link (410) and forgets the rendered images. Drafts are deleted outright. */
export async function revokeShare(s: S, ws: string, id: string): Promise<void> {
  const row = await ownRow(s, ws, id)
  if (row.status === 'draft') await db(s).deleteFrom('share_cards').where('workspace_id', '=', ws).where('id', '=', id).execute()
  else if (row.status === 'live') await db(s).updateTable('share_cards').set({ status: 'revoked', revoked_at: nowIso(), snapshot: null }).where('workspace_id', '=', ws).where('id', '=', id).execute()
  forgetRenders(id)
}

export async function listShares(s: S, ws: string): Promise<ShareRow[]> {
  return (await db(s).selectFrom('share_cards').selectAll().where('workspace_id', '=', ws).where('status', '!=', 'revoked').orderBy('created_at', 'desc').limit(100).execute()) as ShareRow[]
}

/** The public lookup by link id: any workspace, so a named bypass (docs/security/rls.md). Drafts don't exist publicly. */
export async function publicShare(s: Pick<Services, 'db'>, id: string): Promise<{ status: 'live'; snapshot: ShareSnapshot } | { status: 'revoked' } | null> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null
  const row = await withBypass('share:public-link', () => (s.db as unknown as Kysely<{ share_cards: ShareRow }>).selectFrom('share_cards').select(['kind', 'status', 'snapshot']).where('id', '=', id).executeTakeFirst())
  // A badge lives at /b/<id> (badge.ts), never as a card.
  if (!row || row.status === 'draft' || row.kind === 'badge') return null
  if (row.status === 'revoked' || !row.snapshot) return { status: 'revoked' }
  return { status: 'live', snapshot: JSON.parse(row.snapshot) as ShareSnapshot }
}

// ---------- Words ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const dayText = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`

/** The card's words: headline number, what it is, and the grey line. Shared by the image and the page. */
export function cardWords(c: ShareSnapshot): { big: string; unit: string; line: string; alt: string } {
  const who = c.company ?? 'A company'
  const asOf = `as of ${dayText(c.asOf)}`
  if (c.kind === 'badge') {
    const b = badgeWords(c)
    return { big: b.status, unit: '', line: b.figures, alt: b.alt }
  }
  if (c.kind === 'roast' || c.kind === 'hype') {
    const big = c.kind === 'roast' ? 'Books, roasted' : 'Books, hyped'
    return { big, unit: '', line: `${who} · last 3 months · ${asOf}`, alt: `${big}: ${(c.lines ?? []).join(' ')}` }
  }
  if (c.kind === 'runway') {
    const cash = c.cash ? ` · ${c.cash} cash` : ''
    if (c.months === null || c.months === undefined) return { big: 'Not burning', unit: 'cash', line: `${who} · ${asOf}${cash}`, alt: `${who} isn’t burning cash, ${asOf}.` }
    const unit = c.months === 1 ? 'month of runway' : 'months of runway'
    return { big: String(c.months), unit, line: `${who} · ${asOf}${cash}`, alt: `${who} has ${c.months} ${unit}, ${asOf}.` }
  }
  const pct = c.changePct
  const big = c.cash ?? (pct === null || pct === undefined ? 'Cash' : `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}%`)
  const unit = c.cash ? 'cash' : pct === null || pct === undefined ? 'over 12 months' : 'cash over 12 months'
  const change = c.cash && pct !== null && pct !== undefined ? ` · ${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}% over 12 months` : ''
  return { big, unit, line: `${who} · ${asOf}${change}`, alt: `${who}: ${big} ${unit}, ${asOf}.` }
}

// ---------- Images ----------

const INK = '#1F1B1C'
const GREY = '#8C8587'
const BG = '#FAF9F7'
export const SIZES = { og: [1200, 630], card: [1080, 1080] } as const
export type ShareSize = keyof typeof SIZES

type Node = { type: string; props: Record<string, unknown> }
const h = (type: string, style: Record<string, unknown>, ...children: Array<Node | string>): Node => ({ type, props: { style, children: children.length === 1 ? children[0] : children } })
const svg = (w: number, hgt: number, viewBox: string, attrs: Record<string, unknown>, d: string): Node => ({ type: 'svg', props: { width: w, height: hgt, viewBox, fill: 'none', ...attrs, children: { type: 'path', props: { d } } } })
const MARK = 'M50 12V88M50 12 33 88M50 12 67 88M50 12 16 88M50 12 84 88'

function sparkline(points: number[], w: number, hgt: number): Node {
  const step = w / (points.length - 1)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${(hgt - 4 - p * (hgt - 8)).toFixed(1)}`).join('')
  return svg(w, hgt, `0 0 ${w} ${hgt}`, { stroke: INK, strokeWidth: 3, strokeLinecap: 'round', strokeLinejoin: 'round' }, d)
}

function cardTree(c: ShareSnapshot, size: ShareSize): Node {
  const [w, hgt] = SIZES[size]
  const words = cardWords(c)
  const square = size === 'card'
  if (c.lines) return linesTree(c, words, w, hgt, square)
  const bigSize = words.big.length > 6 ? (square ? 150 : 140) : square ? 280 : 220
  const tick = svg(22, 22, '0 0 24 24', { stroke: GREY, strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }, 'M5 12.5l4.5 4.5L19 7.5')
  return h(
    'div',
    { width: w, height: hgt, background: BG, color: INK, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: square ? 88 : 72, fontFamily: 'G' },
    h('div', { display: 'flex', alignItems: 'center', gap: 14, fontSize: 26 }, svg(36, 36, '0 0 100 100', { stroke: INK, strokeWidth: 3, strokeLinecap: 'round' }, MARK), 'Aggregate'),
    h(
      'div',
      { display: 'flex', flexDirection: 'column' },
      h('div', { display: 'flex', flexDirection: square ? 'column' : 'row', alignItems: square ? 'flex-start' : 'flex-end', gap: square ? 8 : 28 }, h('div', { fontFamily: 'N', fontSize: bigSize, lineHeight: 0.9, letterSpacing: -4 }, words.big), h('div', { fontFamily: 'N', fontSize: 56, paddingBottom: square ? 0 : 10 }, words.unit)),
      ...(c.points ? [h('div', { display: 'flex', marginTop: 36 }, sparkline(c.points, w - (square ? 176 : 144), square ? 200 : 90))] : []),
      h('div', { display: 'flex', fontSize: 28, color: GREY, marginTop: 28 }, words.line),
    ),
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 24, color: GREY }, h('div', { display: 'flex', alignItems: 'center', gap: 8 }, c.reconciled ? 'Reconciled' : 'Not reconciled', ...(c.reconciled ? [tick] : [])), h('div', { display: 'flex' }, 'Ask your AI about your own finances →')),
  )
}

/** roast/hype: a quiet title, then up to three lines, then who and when. */
function linesTree(c: ShareSnapshot, words: ReturnType<typeof cardWords>, w: number, hgt: number, square: boolean): Node {
  const shown = (c.lines ?? []).slice(0, square ? 3 : 2)
  return h(
    'div',
    { width: w, height: hgt, background: BG, color: INK, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: square ? 88 : 64, fontFamily: 'G' },
    h('div', { display: 'flex', alignItems: 'center', gap: 14, fontSize: 26 }, svg(36, 36, '0 0 100 100', { stroke: INK, strokeWidth: 3, strokeLinecap: 'round' }, MARK), 'Aggregate'),
    h(
      'div',
      { display: 'flex', flexDirection: 'column', gap: square ? 28 : 18 },
      h('div', { fontFamily: 'N', fontSize: square ? 84 : 64, lineHeight: 1, letterSpacing: -2 }, words.big),
      ...shown.map((l) => h('div', { fontFamily: 'N', fontSize: square ? 40 : 32, lineHeight: 1.25 }, l)),
    ),
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 22, color: GREY }, h('div', { display: 'flex' }, words.line), h('div', { display: 'flex' }, 'Ask your AI about your own finances →')),
  )
}

const require = createRequire(import.meta.url)
let engine: Promise<{ satori: (n: unknown, o: unknown) => Promise<string>; Resvg: new (svg: string, o: unknown) => { render(): { asPng(): Uint8Array } }; fonts: unknown[] }> | null = null
function loadEngine() {
  engine ??= (async () => {
    const [{ default: satori }, resvg] = await Promise.all([import('satori'), import('@resvg/resvg-wasm')])
    await resvg.initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')))
    const font = (pkg: string, file: string) => readFileSync(require.resolve(`@fontsource/${pkg}/files/${file}`))
    const fonts = [
      { name: 'N', data: font('newsreader', 'newsreader-latin-300-normal.woff'), weight: 400, style: 'normal' },
      { name: 'N', data: font('newsreader', 'newsreader-latin-ext-300-normal.woff'), weight: 400, style: 'normal' },
      { name: 'G', data: font('geist-sans', 'geist-sans-latin-400-normal.woff'), weight: 400, style: 'normal' },
    ]
    return { satori: satori as never, Resvg: resvg.Resvg as never, fonts }
  })().catch((e) => {
    engine = null
    throw e
  })
  return engine
}

export async function renderCard(c: ShareSnapshot, size: ShareSize): Promise<Uint8Array> {
  const { satori, Resvg, fonts } = await loadEngine()
  const [w, hgt] = SIZES[size]
  const out = await satori(cardTree(c, size), { width: w, height: hgt, fonts })
  return new Resvg(out, { fitTo: { mode: 'original' } }).render().asPng()
}

// Rendered images per link, so a busy link renders once per instance. Dropped on revoke; a revoked link is checked in
// the database on every request before this cache is used, so another instance's copy is never served after revoke.
const renders = new Map<string, Uint8Array>()
const MAX_RENDERS = 200
export async function cachedRender(id: string, c: ShareSnapshot, size: ShareSize): Promise<Uint8Array> {
  const key = `${id}:${size}`
  const hit = renders.get(key)
  if (hit) return hit
  const png = await renderCard(c, size)
  if (renders.size >= MAX_RENDERS) renders.delete(renders.keys().next().value!)
  renders.set(key, png)
  return png
}
export function forgetRenders(id: string): void {
  for (const size of Object.keys(SIZES)) renders.delete(`${id}:${size}`)
}

// ---------- The public page ----------

const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

export function sharePage(baseUrl: string, id: string, c: ShareSnapshot, fonts: { geist?: string } = {}): string {
  const base = baseUrl.replace(/\/+$/, '')
  const w = cardWords(c)
  const title = c.kind === 'runway' ? (c.months === null || c.months === undefined ? 'Not burning cash' : `${w.big} ${w.unit}`) : c.lines ? w.big : `${w.big} ${w.unit}`
  const font = fonts.geist ? `@font-face{font-family:G;src:url(${esc(fonts.geist)}) format('woff2');font-weight:100 900}` : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Aggregate</title><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta name="description" content="${esc(w.alt)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(w.alt)}">
<meta property="og:image" content="${base}/a/${id}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${base}/a/${id}"><meta name="twitter:card" content="summary_large_image">
<style>${font}
:root{--bg:#FAF9F7;--ink:#1F1B1C;--grey:#8C8587;--line:#E6E2DE}
@media (prefers-color-scheme:dark){:root{--bg:#141213;--ink:#F2EFEC;--grey:#9A9395;--line:#2A2627}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:400 15px/1.5 G,system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:48px 16px 64px}
img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:12px}
p{color:var(--grey);margin:16px 0 0}a{color:var(--ink)}
.cta{display:inline-block;margin-top:28px;text-decoration:none;border-bottom:1px solid var(--line)}
</style></head><body><main>
<picture><source media="(max-width: 600px)" srcset="/a/${id}/card.png" width="1080" height="1080"><img src="/a/${id}/og.png" width="1200" height="630" alt="${esc(w.alt)}"></picture>
<p>${esc(c.reconciled ? 'Reconciled: every figure is known and up to date.' : 'Not reconciled: some figures were waiting on a source.')} Shared from Aggregate as of ${esc(dayText(c.asOf))}.</p>
<a class="cta" href="https://aggregate.finance">Ask your AI about your own finances →</a>
</main></body></html>`
}

export function gonePage(fonts: { geist?: string } = {}, gone = true): string {
  const font = fonts.geist ? `@font-face{font-family:G;src:url(${esc(fonts.geist)}) format('woff2');font-weight:100 900}` : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${gone ? 'No longer shared' : 'Not found'} · Aggregate</title><meta name="robots" content="noindex,nofollow">
<style>${font}:root{--bg:#FAF9F7;--ink:#1F1B1C;--grey:#8C8587}@media (prefers-color-scheme:dark){:root{--bg:#141213;--ink:#F2EFEC;--grey:#9A9395}}
html,body{margin:0;background:var(--bg);color:var(--ink);font:400 15px/1.5 G,system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:96px 16px}p{color:var(--grey)}a{color:var(--ink)}</style></head>
<body><main><h1 style="font-weight:400;font-size:22px">${gone ? 'This card is no longer shared.' : 'There’s no card here.'}</h1><p><a href="https://aggregate.finance">Ask your AI about your own finances →</a></p></main></body></html>`
}

// ---------- For an AI's share_answer (S7 tool) ----------

/**
 * Drafts only: publishing a public link is the person's act, in the app ("Publish this card?"). For roast/hype the
 * answer carries the exact template lines the card will show (so the AI shows those, never its own). When there's no
 * card to make (not reconciled, under six months for a roast…), the draft is removed and the ShareError (422) carries
 * the plain reason, which share_answer passes on as is. Vendor names only when asked.
 */
export interface SharePort {
  draft(i: { workspaceId: string; personId: string; entityId: string; kind: ShareKind; source: string; vendors?: boolean }): Promise<{ id: string; reviewUrl: string; lines?: string[] }>
}
export function makeSharePort(s: S, baseUrl: string): SharePort {
  const review = (id: string) => `${baseUrl.replace(/\/+$/, '')}/#/?d=share:${id}`
  return {
    async draft(i) {
      if (i.kind === 'badge') throw new ShareError(422, 'Badges are made in the Aggregate app by an owner or admin.')
      const { id } = await draftShare(s, i)
      if (i.kind !== 'roast' && i.kind !== 'hype') return { id, reviewUrl: review(id) }
      try {
        const card = await previewShare(s, i.workspaceId, i.personId, id, { amounts: false, name: false, vendors: !!i.vendors })
        return { id, reviewUrl: review(id), lines: card.lines ?? [] }
      } catch (e) {
        // Nothing to publish: don't leave a draft behind, and say why (the 422's message).
        if (e instanceof ShareError && e.status === 422) await revokeShare(s, i.workspaceId, id)
        throw e
      }
    },
  }
}
