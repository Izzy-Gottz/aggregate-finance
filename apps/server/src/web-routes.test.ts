// Every route the web client calls (apps/web/src/api/http.ts ROUTES) is served here, so no screen 404s on a real
// server. Reads the route declarations from source; /api/auth/* belongs to Better Auth.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ROUTES } from '../../web/src/api/http.ts'

const here = dirname(fileURLToPath(import.meta.url))

describe('web routes', () => {
  it('apps/server serves every route the web client uses', () => {
    const files = [join(here, 'app.ts'), ...readdirSync(join(here, 'routes')).filter((f) => f.endsWith('.ts') && !f.includes('.test.')).map((f) => join(here, 'routes', f))]
    const src = files.map((f) => readFileSync(f, 'utf8')).join('\n')
    const served = new Set<string>()
    for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) served.add(`${m[1]!.toUpperCase()} ${m[2]!.startsWith('/api') ? m[2] : `/api${m[2]}`}`)
    expect(ROUTES.filter((r) => !r.includes(' /api/auth/') && !served.has(r))).toEqual([])
  })
})
