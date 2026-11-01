// "Verified by Aggregate" badges (launch plan, 34-approved): a company's MRR band, its growth and its runway band, each
// shown only when the owner turns it on. Unlike a card, a badge stays live: it is checked again once a day, and when
// Aggregate can't vouch for the books that day it says "Not current" in grey and keeps the last verified figures. The
// figures come from @agfn/core's verifiedBadges (the app's own metrics); never from the browser or an AI. A badge is
// the owner's act in the app only (an AI can't draft one). Behind AGFN_BADGES (off by default).
//
// Public: /b/<id> (a page), /b/<id>.svg (the embed), /how-we-verify (what the badge means).

import type { Kysely } from 'kysely'
import { verifiedBadges, type VerifiedBadges } from '@agfn/core'
import { nowIso, withBypass, withWorkspace } from '@agfn/db'
import type { Services } from './services.ts'
import { dayText, ShareError, type ShareRow, type ShareSnapshot } from './share.ts'

export type BadgeField = 'mrr' | 'growth' | 'runway'
export const BADGE_FIELDS: BadgeField[] = ['mrr', 'growth', 'runway']

/** One figure as the badge shows it: MRR as a band, growth to the whole percent, runway as a band. */
export interface BadgeFigure {
  key: BadgeField
  label: string
  display: string
}

type Engine = Parameters<typeof verifiedBadges>[0]
type S = Pick<Services, 'db' | 'ledger'>

function engineOf(s: S): Engine {
  const e = s.ledger as unknown as Partial<Engine>
  if (typeof e.metric !== 'function' || typeof e.dataHealth !== 'function' || typeof e.now !== 'function') throw new ShareError(422, 'Badges need Aggregate’s own ledger.')
  return e as Engine
}

const MRR_BANDS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000]
const k = (d: number) => (d >= 1_000_000 ? `$${d / 1_000_000}M` : `$${d / 1_000}K`)
/** MRR in dollars, as a band ("$10K–$25K"), so the badge never shows the exact figure. */
export function mrrBand(dollars: number): string {
  if (dollars < MRR_BANDS[0]!) return `Under ${k(MRR_BANDS[0]!)}`
  for (let i = 1; i < MRR_BANDS.length; i++) if (dollars < MRR_BANDS[i]!) return `${k(MRR_BANDS[i - 1]!)}–${k(MRR_BANDS[i]!)}`
  return `${k(MRR_BANDS[MRR_BANDS.length - 1]!)}+`
}

/** The chosen figures that are known, in the badge's words. */
export function badgeFigures(v: VerifiedBadges, fields: BadgeField[]): BadgeFigure[] {
  const out: BadgeFigure[] = []
  for (const b of v.badges) {
    if (!fields.includes(b.key) || b.state !== 'ok') continue
    if (b.key === 'mrr' && b.value && typeof b.value === 'object') out.push({ key: 'mrr', label: 'MRR', display: mrrBand(b.value.minor / 100) })
    else if (b.key === 'growth' && typeof b.value === 'number') {
      const p = Math.round(b.value * 100)
      out.push({ key: 'growth', label: b.label, display: `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p)}% ${b.label === 'MRR growth' ? 'in 3 months' : 'on the 3 months before'}` })
    } else if (b.key === 'runway' && b.band) out.push({ key: 'runway', label: 'Runway', display: b.band })
  }
  return out
}

/** A badge as it would publish now. Refuses unless Aggregate can vouch for the books today and a chosen figure is known. */
export async function badgeSnapshot(s: S, ws: string, entity: { id: string; name: string }, opts: { name: boolean; fields?: BadgeField[] }): Promise<ShareSnapshot> {
  const fields = BADGE_FIELDS.filter((f) => opts.fields?.includes(f))
  if (!fields.length) throw new ShareError(422, 'Turn on at least one figure to show.')
  const v = await verifiedBadges(engineOf(s), ws, entity.id)
  if (!v.verified) throw new ShareError(422, `Aggregate can’t vouch for these books today: ${v.reasons.join('; ').replace(/^./, (c) => c.toLowerCase())}.`)
  const figures = badgeFigures(v, fields)
  // Every figure turned on must be known now: a badge never publishes a blank.
  const missing = v.badges.filter((b) => fields.includes(b.key) && b.state !== 'ok')
  if (missing.length) throw new ShareError(422, `${missing.map((m) => `${m.label} isn’t known yet: ${m.formula.charAt(0).toLowerCase()}${m.formula.slice(1)}`).join(' ')} Turn ${missing.length === 1 ? 'it' : 'them'} off to publish the rest.`)
  return { kind: 'badge', asOf: v.asOf, reconciled: true, ...(opts.name ? { company: entity.name } : {}), fields, badges: figures, current: true, checkedAt: nowIso() }
}

// ---------- Live: checked again once a day ----------

const today = () => new Date().toISOString().slice(0, 10)
export const NOT_AVAILABLE = 'Not available'
const inflight = new Map<string, Promise<ShareSnapshot>>()
/** After a failed check, wait this long before trying again (a broken check never runs on every request). */
const RETRY_MS = 10 * 60_000
const failedAt = new Map<string, number>()

async function recheck(s: S, row: Pick<ShareRow, 'id' | 'workspace_id' | 'entity_id'>, snap: ShareSnapshot): Promise<ShareSnapshot> {
  return withWorkspace(row.workspace_id, async () => {
    const entity = await s.db.selectFrom('entities').select(['id', 'archived_at']).where('workspace_id', '=', row.workspace_id).where('id', '=', row.entity_id).executeTakeFirst()
    let next: ShareSnapshot = { ...snap, current: false, checkedAt: nowIso() }
    if (entity && !entity.archived_at) {
      const v = await verifiedBadges(engineOf(s), row.workspace_id, row.entity_id)
      // Not verified: keep the last verified figures, marked not current. Verified: fresh figures; one that's no longer
      // known shows "Not available" on its own, and the badge stays current (the books are fine).
      if (v.verified) {
        const fresh = new Map(badgeFigures(v, snap.fields ?? []).map((f) => [f.key, f]))
        const badges = (snap.badges ?? []).map((b) => fresh.get(b.key) ?? { ...b, display: NOT_AVAILABLE })
        next = { ...next, asOf: v.asOf, badges, current: true }
      }
    }
    await (s.db as unknown as Kysely<{ share_cards: ShareRow }>).updateTable('share_cards').set({ snapshot: JSON.stringify(next) }).where('workspace_id', '=', row.workspace_id).where('id', '=', row.id).where('status', '=', 'live').execute()
    return next
  })
}

/** The public lookup for /b/<id>: a live badge (checked today), a revoked one, or nothing. Cards are not badges. */
export async function liveBadge(s: S, id: string): Promise<{ status: 'live'; snapshot: ShareSnapshot } | { status: 'revoked' } | null> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return null
  const row = await withBypass('share:public-link', () => (s.db as unknown as Kysely<{ share_cards: ShareRow }>).selectFrom('share_cards').select(['id', 'workspace_id', 'entity_id', 'kind', 'status', 'snapshot']).where('id', '=', id).executeTakeFirst())
  if (!row || row.kind !== 'badge' || row.status === 'draft') return null
  if (row.status === 'revoked' || !row.snapshot) return { status: 'revoked' }
  const snap = JSON.parse(row.snapshot) as ShareSnapshot
  if ((snap.checkedAt ?? '').slice(0, 10) === today() || Date.now() - (failedAt.get(id) ?? 0) < RETRY_MS) return { status: 'live', snapshot: snap }
  let p = inflight.get(id)
  if (!p) {
    p = recheck(s, row, snap).finally(() => inflight.delete(id))
    inflight.set(id, p)
  }
  try {
    return { status: 'live', snapshot: await p }
  } catch (e) {
    failedAt.set(id, Date.now())
    console.warn(`[badge] recheck failed for a badge: ${(e as Error).message}`)
    return { status: 'live', snapshot: snap }
  }
}

// ---------- Words, the embed and the pages ----------

const esc = (t: string) => t.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

export function badgeWords(c: ShareSnapshot): { status: string; figures: string; line: string; alt: string } {
  const status = c.current === false ? 'Not current' : 'Verified by Aggregate'
  const figures = (c.badges ?? []).map((b) => `${b.label} ${b.display}`).join(' · ')
  const line = `${c.company ?? 'A company'} · month ending ${dayText(c.asOf)}`
  return { status, figures, line, alt: `${c.company ?? 'A company'}: ${figures}. ${status}, month ending ${dayText(c.asOf)}.` }
}

/** Rough text width at 11px in a system sans (no font file in the SVG); generous so text never clips. */
const textWidth = (t: string) => Math.ceil([...t].reduce((w, ch) => w + (/[ il.,·'|]/.test(ch) ? 3.4 : /[A-Z$%+–—]/.test(ch) ? 7.6 : 6.6), 0))

/** The embed: a small two-part badge, like a build badge. Grey on the left when not current. */
export function badgeSvg(c: ShareSnapshot): string {
  const w = badgeWords(c)
  const left = c.current === false ? 'Not current' : 'Verified by Aggregate'
  const right = w.figures || 'No figures'
  const lw = textWidth(left) + 20
  const rw = textWidth(right) + 20
  const W = lw + rw
  const leftBg = c.current === false ? '#8C8587' : '#1F1B1C'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="22" viewBox="0 0 ${W} 22" role="img" aria-label="${esc(w.alt)}"><title>${esc(w.alt)}</title>
<rect width="${W}" height="22" rx="4" fill="#FAF9F7" stroke="#E6E2DE"/><path d="M4 0h${lw - 4}v22H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4z" fill="${leftBg}"/>
<g font-family="system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif" font-size="11"><text x="${lw / 2}" y="15" fill="#FAF9F7" text-anchor="middle">${esc(left)}</text><text x="${lw + rw / 2}" y="15" fill="#1F1B1C" text-anchor="middle">${esc(right)}</text></g></svg>`
}

const STYLE = (font: string) => `${font}
:root{--bg:#FAF9F7;--ink:#1F1B1C;--grey:#8C8587;--line:#E6E2DE}
@media (prefers-color-scheme:dark){:root{--bg:#141213;--ink:#F2EFEC;--grey:#9A9395;--line:#2A2627}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:400 15px/1.5 G,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:48px 16px 64px}h1{font-weight:400;font-size:22px;margin:0}h2{font-weight:400;font-size:17px;margin:32px 0 4px}
p,li{color:var(--grey)}a{color:var(--ink)}.rows{margin-top:24px;border-top:1px solid var(--line)}
.row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}.row span:last-child{text-align:right}
.status{color:var(--grey);margin-top:4px}.cta{display:inline-block;margin-top:28px;text-decoration:none;border-bottom:1px solid var(--line)}`
const fontCss = (fonts: { geist?: string }) => (fonts.geist ? `@font-face{font-family:G;src:url(${esc(fonts.geist)}) format('woff2');font-weight:100 900}` : '')

export function badgePage(baseUrl: string, id: string, c: ShareSnapshot, fonts: { geist?: string } = {}): string {
  const base = baseUrl.replace(/\/+$/, '')
  const w = badgeWords(c)
  const title = `${c.company ?? 'A company'} · ${w.status}`
  const checked = c.checkedAt ? dayText(c.checkedAt.slice(0, 10)) : dayText(c.asOf)
  const status = c.current === false ? `Not current: Aggregate couldn’t vouch for these books when it last checked (${checked}). These are the last verified figures.` : `Verified by Aggregate. Checked ${checked}.`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer">
<meta name="description" content="${esc(w.alt)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(w.alt)}"><meta property="og:url" content="${base}/b/${id}">
<style>${STYLE(fontCss(fonts))}</style></head><body><main>
<h1>${esc(c.company ?? 'A company')}</h1><p class="status">${esc(status)}</p>
<div class="rows">${(c.badges ?? []).map((b) => `<div class="row"><span>${esc(b.label)}</span><span>${esc(b.display)}</span></div>`).join('')}</div>
<p>Figures for the month ending ${esc(dayText(c.asOf))}, from the company’s own connected accounts. <a href="/how-we-verify">How we verify</a></p>
<a class="cta" href="https://aggregate.finance">Ask your AI about your own finances →</a>
</main></body></html>`
}

export function howWeVerifyPage(fonts: { geist?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>How we verify · Aggregate</title><meta name="description" content="What a Verified by Aggregate badge means, and what it doesn’t.">
<style>${STYLE(fontCss(fonts))}</style></head><body><main>
<h1>How we verify</h1>
<p>A “Verified by Aggregate” badge shows figures that come straight from a company’s own connected bank, card and billing accounts, worked out the same way the Aggregate app works them out. Nobody types them in, and no AI writes them.</p>
<h2>What a badge can show</h2>
<ul>
<li><strong>MRR</strong>: monthly recurring revenue from active subscriptions at the end of the last complete month, after discounts and without tax or usage. Shown as a range, never the exact figure.</li>
<li><strong>Growth</strong>: MRR now against three months earlier. Without subscriptions, revenue for the last three complete months against the three before. Rounded to the whole percent.</li>
<li><strong>Runway</strong>: cash on hand divided by the average net burn of the last three complete months, shown as a range: under 6 months, 6–12, 12–24, 24+, or not burning.</li>
</ul>
<p>Money moving between the company’s own accounts, payouts from a payment processor, and money the owners put in or take out are never counted as revenue or burn.</p>
<h2>When it says “Verified”</h2>
<p>We check each badge again every day. It says Verified only when, that day:</p>
<ul>
<li>every reconciliation check passes (the books agree with the bank),</li>
<li>nothing is waiting for review (every question about where money came from or went is answered),</li>
<li>no money has been in transit for more than a week,</li>
<li>every connected account synced within the last day,</li>
<li>no month of statements is missing, and</li>
<li>there are at least two complete months of history.</li>
</ul>
<p>If any of these fails, the badge turns grey and says <strong>Not current</strong>, keeping the last figures we could vouch for.</p>
<p>If the books check out but one figure can no longer be worked out (say, a billing account was disconnected), that figure alone says <strong>Not available</strong>.</p>
<h2>What it doesn’t mean</h2>
<p>A badge is not an audit, and it doesn’t check whether the accounts are complete: a company could leave an account unconnected. It says the figures match the accounts the company connected, on the date shown.</p>
<h2>Who decides</h2>
<p>Only an owner or admin of the company can publish a badge, and they choose each figure it shows. It’s done in the Aggregate app, never by an AI assistant. Revoking a badge turns it off at once.</p>
<a class="cta" href="https://aggregate.finance">Ask your AI about your own finances →</a>
</main></body></html>`
}
