import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { buildOpenApi } from '@agfn/mcp'
import { apiDocsMarkdown } from './api-docs.ts'

describe('/docs/api', () => {
  it('lists every /v1 operation from the server\'s own OpenAPI, publicly', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
    const booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
    try {
      const app = createApp(booted.services)
      const spec = buildOpenApi('http://localhost:8787/mcp') as { paths: Record<string, Record<string, unknown>> }
      expect(Object.keys(spec.paths).length).toBeGreaterThan(30)
      const r = await app.request('/docs/api')
      expect(r.status).toBe(200)
      const html = await r.text()
      expect(html).toContain('<title>Aggregate REST API · Aggregate</title>')
      for (const [path, byMethod] of Object.entries(spec.paths)) for (const m of Object.keys(byMethod)) expect(html, `${m} ${path}`).toContain(`<code>${m.toUpperCase()} ${path}</code>`)
      expect(html).toContain('Authorization: Bearer')
      expect(html).not.toContain('```')
    } finally {
      await booted.shutdown()
    }
  })

  it('keeps table rows intact when a description has a pipe or line break', () => {
    const md = apiDocsMarkdown({
      paths: { '/v1/x': { get: { operationId: 'get_x', summary: 'Get x', tags: ['Read'], description: 'Reads x.', parameters: [{ name: 'q', in: 'query', description: 'a | b\nc', schema: { type: 'string' } }] } } },
    })
    expect(md).toContain('| `q` | query | string |  | a / b c |')
  })
})
