// Accuracy scenarios: load a fixture (provider events + what the person did) through the real server, then check every
// answer in its independent key (scripts/accuracy/key.py) against the MCP tools, to the cent. See docs/accuracy/README.md.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { withBypass } from '@agfn/db'
import type { NormalizedEvent } from '@agfn/contracts'
import { accountIds, connectAi, connectProvider, entities, minor, READ_WRITE_ALL, signIn, startServer, type Ai, type Server } from '../scenarios/harness.ts'

export interface Fixture {
  scenario: string
  now: string
  timeZone: string
  company: string | null
  /** More companies (the first is `company`); currency = the company's books. */
  companies?: Array<{ name: string; currency: string }>
  /** FX rates the books use, seeded before any sync (no live rates in a key). */
  rates?: Array<{ date: string; from: string; to: string; rate: string }>
  connections: Array<{ id: string; key: string; name: string; entity: string | null; assign?: Record<string, string>; events: Array<Record<string, unknown>> }>
  /** Statement files uploaded to a company, in order. */
  uploads?: Array<{ entity: string; name: string; csv: string }>
  actions: Array<{ do: string; args?: Record<string, unknown>; externalId?: string; externalIds?: string[]; kind?: string; ifAsked?: boolean }>
}

export interface KeyQuestion {
  id: string
  question: string
  answer: { type: 'money' | 'number' | 'count' | 'text'; value: string | number }
  tolerance: { abs: number } | null
  notes: string
  /** A known product bug makes this answer wrong; the suite expects it wrong and fails once it's right (drop the marker). */
  known_issue?: string
  /** Null: asked only through the apps (no single tool answers it, e.g. net worth). */
  check: { tool: string; args: Record<string, unknown>; path: string; abs?: boolean } | null
}

export function readScenario(dir: string): { fixture: Fixture; key: { fixture_sha256: string; questions: KeyQuestion[] }; raw: Buffer } {
  const raw = readFileSync(join(dir, 'fixture.json'))
  return { fixture: JSON.parse(raw.toString()), key: JSON.parse(readFileSync(join(dir, 'key.json'), 'utf8')), raw }
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** Boot a server, sign the person in, connect and sync every provider, then do what the person did. */
export async function loadScenario(fx: Fixture, opts: { pglite?: boolean } = {}): Promise<{ srv: Server; ai: Ai; keyFor: () => Promise<Ai> }> {
  const srv = await startServer(opts)
  let s = await signIn(srv, `${fx.scenario}@example.com`, fx.company ?? undefined)
  if (fx.company === null) {
    // Personal only: a workspace with no company.
    const ws = await s.post<{ workspaceId: string }>('/api/workspaces', {})
    if (ws.status !== 200 && ws.status !== 201) throw new Error(`create workspace: ${ws.status} ${JSON.stringify(ws.body)}`)
    s = { ...s, workspaceId: ws.body.workspaceId }
  }
  for (const c of fx.companies ?? []) {
    const r = await s.post('/api/entities', { name: c.name, currency: c.currency })
    if (r.status !== 201) throw new Error(`add company ${c.name}: ${r.status} ${JSON.stringify(r.body)}`)
  }
  const E = await entities(s)
  if (fx.rates?.length) {
    const db = srv.booted.services.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    const rows = fx.rates.map((r) => ({ date: r.date, from_currency: r.from, to_currency: r.to, rate: r.rate, source: 'fixture', created_at: fx.now }))
    // The fixture's rates replace anything already cached (fetched live while the companies were set up).
    for (const pair of new Set(fx.rates.map((r) => `${r.from}|${r.to}`))) {
      const [from, to] = pair.split('|') as [string, string]
      await withBypass('test:rates', () => db.deleteFrom('fx_rates').where('from_currency', '=', from).where('to_currency', '=', to).execute())
    }
    for (let i = 0; i < rows.length; i += 200) await withBypass('test:rates', () => db.insertInto('fx_rates').values(rows.slice(i, i + 200)).execute())
  }
  for (const c of fx.connections) {
    const p = await connectProvider(srv, s, c.key as never, { name: c.name, entityId: c.entity === null ? null : c.entity === 'Personal' ? E.Personal : E[c.entity] })
    p.push((id) => c.events.map((e) => ({ ...e, connectionId: id }) as unknown as NormalizedEvent))
    const r = await p.sync()
    if (r.status !== 'ok') throw new Error(`${c.id} sync: ${r.status} ${r.message ?? ''}`)
    if (c.assign) {
      const ids = await accountIds(srv, p.id)
      const res = await s.post('/api/accounts/assign', { assignments: Object.entries(c.assign).map(([ext, who]) => ({ accountId: ids[ext], entityId: who === 'Personal' ? 'personal' : E[who] })) })
      if (res.status !== 200) throw new Error(`assign ${c.id}: ${res.status} ${JSON.stringify(res.body)}`)
    }
  }
  for (const u of fx.uploads ?? []) {
    const form = new FormData()
    form.set('file', new File([u.csv], u.name))
    form.set('entityId', E[u.entity] as string)
    let r = await s.post<{ documentId: string; state: string; message?: string; accounts?: Array<{ id: string }> }>('/api/documents', null, { raw: form })
    // A later export of the same account: the statement asks which account it is for, and it's the one already there.
    if (r.body.state === 'needs_account' && r.body.accounts?.length === 1) r = await s.post(`/api/documents/${r.body.documentId}/account`, { accountId: r.body.accounts[0]!.id })
    if (r.status >= 300 || r.body.state !== 'imported') {
      const conns = await withBypass('test:read', () => srv.booted.services.db.selectFrom('connections').selectAll().where('workspace_id', '=', s.workspaceId).execute())
      throw new Error(`upload ${u.name}: ${r.status} ${JSON.stringify(r.body)} connections: ${JSON.stringify(conns.map((c) => [c.connector_key, c.status, (c as Record<string, unknown>).last_error]))}`)
    }
  }
  // The person's own key: every company and, explicitly, their Personal space (never included by "all").
  const keyFor = () => connectAi(srv, s, { ...READ_WRITE_ALL, entityIds: Object.values(E), dataTypes: [...READ_WRITE_ALL.dataTypes, 'personal'] })
  const ai = await keyFor()
  const recordIdOf = async (externalId: string) => {
    const row = await withBypass('test:read', () => srv.booted.services.db.selectFrom('ledger_records' as never).select('id' as never).where('external_id' as never, '=', externalId as never).executeTakeFirst())
    if (!row) throw new Error(`no record ${externalId}`)
    return (row as { id: string }).id
  }
  const review = async () => {
    const out: Array<{ id: string; kind: string; record_ids: string[] }> = []
    for (const name of Object.keys(E)) out.push(...(await ai.call<{ items: Array<{ id: string; kind: string; record_ids: string[] }> }>('list_review_items', { company: name })).items)
    return out
  }
  for (const a of fx.actions) {
    if (a.do === 'confirm_all_matches') {
      // Each confirm can settle others (and propose new ones): ask again until none are left.
      for (let i = 0; i < 50; i++) {
        const next = (await review()).find((r) => r.kind === 'suggested_match')
        if (!next) break
        await ai.call('resolve_review_item', { id: next.id, decision: 'confirm', idempotency_key: `acc-confirm-${i}-${next.id}`.slice(0, 64) })
      }
    } else if (a.do === 'reject_matches') {
      for (const ext of a.externalIds ?? []) {
        const id = await recordIdOf(ext)
        for (const item of (await review()).filter((r) => r.kind === 'suggested_match' && r.record_ids.includes(id))) {
          await ai.call('resolve_review_item', { id: item.id, decision: 'reject', idempotency_key: `acc-reject-${item.id}`.slice(0, 64) })
        }
      }
    } else if (a.do === 'answer_money') {
      const id = await recordIdOf(a.externalId as string)
      const item = (await review()).find((r) => r.record_ids.includes(id))
      if (!item && a.ifAsked) continue
      if (!item) throw new Error(`nothing in Review for ${a.externalId}`)
      await ai.call('resolve_review_item', { id: item.id, decision: 'edit', edits: { kind: a.kind as string }, idempotency_key: `acc-answer-${a.externalId}`.slice(0, 64) })
    } else {
      await ai.call(a.do, a.args ?? {})
    }
  }
  return { srv, ai, keyFor }
}

/**
 * Reads a field out of a tool answer. Segments: `name`, `name[0]`, `name[*]` (every element), `name[field=value]`
 * (elements whose field equals value), `name[field~text]` (field contains text, any case), and a final `length`.
 */
export function pick(data: unknown, path: string): unknown[] {
  let cur: unknown[] = [data]
  for (const seg of path.split('.')) {
    const m = /^([^[]*)(?:\[(.*)\])?$/.exec(seg)!
    const [, name, sel] = m
    const next: unknown[] = []
    for (const v of cur) {
      if (name === 'length' && sel === undefined) {
        next.push(Array.isArray(v) ? v.length : undefined)
        continue
      }
      const x = name ? (v as Record<string, unknown> | null)?.[name as string] : v
      if (sel === undefined) next.push(x)
      else if (!Array.isArray(x)) continue
      else if (sel === '*') next.push(...x)
      else if (/^\d+$/.test(sel)) next.push(x[Number(sel)])
      else {
        const eq = /^([^=~]+)([=~])(.*)$/.exec(sel)!
        for (const el of x) {
          const f = String((el as Record<string, unknown>)?.[eq[1] as string] ?? '')
          if (eq[2] === '=' ? f === eq[3] : f.toLowerCase().includes((eq[3] as string).toLowerCase())) next.push(el)
        }
      }
    }
    cur = next
  }
  return cur
}

/** What a tool answered for a question, in the key's terms (money in minor units, summed when several fields match). */
export function actual(q: KeyQuestion, data: unknown): number | string | null {
  const c = q.check as NonNullable<KeyQuestion['check']>
  const vals = pick(data, c.path).filter((v) => v !== undefined && v !== null)
  if (!vals.length) return null
  if (q.answer.type === 'money') {
    const sum = vals.reduce<number>((s, v) => s + (minor(typeof v === 'string' ? { amount: v } : (v as { amount: string })) ?? 0), 0)
    return c.abs ? Math.abs(sum) : sum
  }
  if (q.answer.type === 'text') return String(vals[0])
  return vals.reduce<number>((s, v) => s + Number(v), 0)
}

export function expected(q: KeyQuestion): number | string {
  return q.answer.type === 'money' ? (minor({ amount: String(q.answer.value) }) as number) : q.answer.type === 'text' ? String(q.answer.value) : Number(q.answer.value)
}

export function matches(q: KeyQuestion, got: number | string | null): boolean {
  if (got === null) return false
  const want = expected(q)
  if (typeof want === 'string' || typeof got === 'string') return String(got) === String(want)
  const tol = q.answer.type === 'money' ? 0 : (q.tolerance?.abs ?? 0)
  return Math.abs(got - want) <= tol + 1e-9
}

/** The suite for one scenario: on SQLite and Postgres, the key matches this fixture and every checked answer matches. */
export function accuracySuite(dir: string, title: string): void {
  const { fixture, key, raw } = readScenario(dir)
  describe.each([['sqlite', false], ['postgres (pglite)', true]] as const)(`${title} on %s`, (_db, pglite) => {
    let loaded: Awaited<ReturnType<typeof loadScenario>>
    beforeAll(async () => {
      // The answers are as of the fixture's day: pin the clock (Date only; timers stay real).
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(fixture.now), shouldAdvanceTime: true })
      loaded = await loadScenario(fixture, { pglite })
    }, 300_000)
    afterAll(async () => {
      await loaded?.ai.close()
      await loaded?.srv.close()
      vi.useRealTimers()
    })

    it('the key was computed from this fixture', () => {
      expect(key.fixture_sha256).toBe(sha256(raw))
    })

    it('every answer matches the key to the cent', async () => {
      const wrong: string[] = []
      const checked = key.questions.filter((q) => q.check)
      // A key may read 60 times a minute: a fresh key every 50 questions keeps the suite under the limit.
      // (Loading used the first key's reads on Review: start on a new one.)
      await loaded.ai.close()
      let ai = (loaded.ai = await loaded.keyFor())
      for (const [n, q] of checked.entries()) {
        if (n > 0 && n % 50 === 0) {
          await ai.close()
          ai = loaded.ai = await loaded.keyFor()
        }
        const c = q.check as NonNullable<KeyQuestion['check']>
        const r = await ai.try(c.tool, c.args)
        const got = r.isError ? null : actual(q, r.data)
        if (got === null && process.env.ACC_DUMP) console.log(q.id, JSON.stringify(r.data).slice(0, 2000))
        if (q.known_issue) {
          if (matches(q, got)) wrong.push(`${q.id}: now matches; the known issue is fixed, remove its marker (${q.known_issue})`)
          continue
        }
        if (!matches(q, got)) wrong.push(`${q.id}: expected ${expected(q)} got ${r.isError ? `error ${r.text.slice(0, 160)}` : got}  [${c.tool} ${c.path}] ${q.notes}`)
      }
      expect(wrong, `${wrong.length} of ${checked.length} wrong:\n${wrong.join('\n')}`).toEqual([])
    }, 300_000)
  })
}
