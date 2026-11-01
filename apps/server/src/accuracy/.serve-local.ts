// 43's local bridge (uncommitted): load a scenario through c6's loader, mint a read-only key, serve on a port.
import { createServer } from 'node:http'
import { writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { readScenario, loadScenario } from './run.ts'
import { BASE, signIn } from '../scenarios/harness.ts'
const dir = join(import.meta.dirname, process.argv[2]!)
const port = Number(process.argv[3] ?? 8848)
const { fixture } = readScenario(dir)
const { srv } = await loadScenario(fixture)
const s = await signIn(srv, `${fixture.scenario}@example.com`)
const all = ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports']
const ents = (await s.get<any>('/api/workspace')).body.entities.map((e: any) => e.id)
const k = await s.post<{ key: string }>('/api/ai/keys', { name: 'accuracy-readonly', shape: { entityIds: ents, dataTypes: [...all, 'personal'], write: false, reviewMode: 'instant', expiresAt: new Date(Date.now() + 864e5).toISOString() } })
if (!k.body.key) throw new Error('key: ' + k.status + ' ' + JSON.stringify(k.body))
writeFileSync(process.argv[4]!, JSON.stringify({ url: `http://localhost:${port}/mcp`, key: k.body.key })); chmodSync(process.argv[4]!, 0o600)
createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer)
  const r = await srv.app.fetch(new Request(BASE + req.url, { method: req.method, headers: req.headers as any, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks) }))
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()))
}).listen(port, '127.0.0.1', () => console.log('ready', port, fixture.scenario))
