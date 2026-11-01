// Plain-text accounting export round trip: the founder's three companies exported as Beancount and as hledger from
// Preferences → Export; the files hold every company's cash to the cent (= the cash metric over REST and MCP), every
// company's books sum to zero, and `hledger check` accepts the file when hledger is installed.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withBypass } from '@agfn/db'
import { accountsOf, parseTotals, type JournalEntry } from '@agfn/plaintext'
import { connectAi, minor } from './harness.ts'
import { startServer } from './harness.ts'
import { founderStory } from './stories.ts'

function hledgerAvailable(): boolean {
  try {
    execFileSync('hledger', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('scenario 10: Beancount and hledger export', () => {
  it('cash per company to the cent, books balance, hledger accepts it', async () => {
    const srv = await startServer()
    try {
      const { s, E } = await founderStory(srv)
      const ai = await connectAi(srv, s)
      const companies = ['Acme', 'Bluebird', 'Harbor'] as const
      const cashMetric = Object.fromEntries(await Promise.all(companies.map(async (c) => [c, minor((await ai.call<{ value: { amount: string } }>('get_metric', { metric: 'cash', company: c })).value)] as const)))
      const ws = (await s.get<{ entities: Array<{ name: string; cash: { minor: number } | null }> }>('/api/workspace')).body
      const journal = (await withBypass('test:journal', () => (srv.booted.services.ledger as unknown as { journal(ws: string, o: object): Promise<JournalEntry[]> }).journal(s.workspaceId, {}))) as JournalEntry[]
      const acctInfo = accountsOf(journal, companies.map((c) => ({ id: E[c] as string, name: c, baseCurrency: 'USD' })))

      for (const format of ['beancount', 'hledger'] as const) {
        const made = await s.post<{ url: string }>('/api/export', { format })
        expect(made.status, JSON.stringify(made.body)).toBe(200)
        const res = await srv.app.request(made.body.url, { headers: { cookie: s.cookie() } })
        const text = await res.text()
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
        expect(res.headers.get('content-disposition')).toMatch(format === 'beancount' ? /\.beancount"$/ : /\.journal"$/)
        // The exporter's own Personal space is included (like the JSON export); nobody else's ever is.
        expect(text).toMatch(/^; Companies: .*Acme \(USD\)/m)
        expect(text).toMatch(/Assets:Personal:/)

        const totals = parseTotals(text)
        for (const c of companies) {
          // Cash: bank, processor and cash-on-hand accounts of the company, as the cash metric counts them.
          const cashNames = [...acctInfo.values()].filter((a) => a.entityId === E[c] && /^(cash|processor):/.test(a.role ?? '')).map((a) => a.name)
          const cash = cashNames.reduce((n, name) => n + (totals.get(name)?.get('USD') ?? 0), 0)
          expect(cash, `${format} ${c} cash`).toBe(cashMetric[c])
          expect(cash, `${format} ${c} vs REST`).toBe(ws.entities.find((e) => e.name === c)?.cash?.minor)
          // Double entry: the company's whole subtree sums to zero.
          const all = [...totals].filter(([name]) => name.split(':')[1] === c).reduce((n, [, m]) => n + (m.get('USD') ?? 0), 0)
          expect(all, `${format} ${c} sums to zero`).toBe(0)
        }

        if (format === 'hledger' && hledgerAvailable()) {
          const dir = mkdtempSync(join(tmpdir(), 'agfn-hledger-'))
          try {
            const file = join(dir, 'books.journal')
            writeFileSync(file, text)
            execFileSync('hledger', ['-f', file, 'check', 'balanced', 'accounts', 'commodities'], { stdio: 'pipe' })
            const bal = execFileSync('hledger', ['-f', file, 'bal', 'Assets:Acme', '-O', 'csv', '--no-total'], { encoding: 'utf8' })
            expect(bal).toContain('Assets:Acme')
          } finally {
            rmSync(dir, { recursive: true, force: true })
          }
        }
      }
      // Bad format is a plain refusal.
      expect((await s.post('/api/export', { format: 'qif' })).status).toBe(400)
      await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)

  it('agfn export writes the same journal from the command line', async () => {
    const srv = await startServer()
    const { s } = await founderStory(srv)
    const viaUi = await (async () => {
      const made = await s.post<{ url: string }>('/api/export', { format: 'hledger' })
      return (await srv.app.request(made.body.url, { headers: { cookie: s.cookie() } })).text()
    })()
    const dir = mkdtempSync(join(tmpdir(), 'agfn-export-'))
    try {
      const { exportCommand } = await import('@agfn/cli')
      const lines: string[] = []
      const io = { env: {}, cwd: dir, out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) }
      // The CLI exports companies only; the UI also adds the exporter's own Personal space.
      const ids = (await s.get<{ entities: Array<{ id: string; kind: string }> }>('/api/workspace')).body.entities.map((e) => e.id)
      // As `agfn export` runs it: inside the CLI's named cross-workspace scope (see packages/cli/src/index.ts).
      expect(await withBypass('cli:export', () => exportCommand(['--format', 'hledger', '--company', ids.join(','), '--out', 'books.journal'], io as never, async () => srv.booted as never))).toBe(0)
      const fromCli = (await import('node:fs')).readFileSync(join(dir, 'books.journal'), 'utf8')
      const strip = (t: string) => t.replace(/^; Generated by .*$/m, '')
      expect(strip(fromCli)).toBe(strip(viaUi))
      expect(await exportCommand(['--format', 'qif'], io as never, async () => srv.booted as never).catch((e: Error) => e.message)).toMatch(/beancount or hledger/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
