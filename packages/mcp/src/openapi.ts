// OpenAPI 3.1 for the REST surface, generated from the same zod schemas the MCP tools use.

import * as z from 'zod/v4'
import { SERVER_INFO } from './mcp-server.ts'
import { ALL_TOOLS, SCOPES, TOOLS_WITH_SET_ASIDES } from './service.ts'

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; description?: string; [k: string]: unknown }

/** `opts.share` / `opts.investments`: whether share_answer / get_investments are on for this server (off while a directory review pins the tool set). */
export function buildOpenApi(resourceUrl: string, opts: { share?: boolean; investments?: boolean; setAsides?: boolean } = {}): Record<string, unknown> {
  const origin = new URL(resourceUrl).origin
  const paths: Record<string, Record<string, unknown>> = {}
  for (const t of opts.setAsides ? TOOLS_WITH_SET_ASIDES : ALL_TOOLS) {
    if (t.requires === 'share' && !opts.share) continue
    if (t.requires === 'investments' && !opts.investments) continue
    const schema = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }) as JsonSchema
    const pathParams = [...t.rest.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)
    const props = schema.properties ?? {}
    const required = new Set(schema.required ?? [])
    const parameters: unknown[] = pathParams.map((p) => ({ name: p, in: 'path', required: true, schema: props[p] ?? { type: 'string' } }))
    const op: Record<string, unknown> = {
      operationId: t.name,
      summary: t.title,
      description: t.description,
      tags: [t.kind === 'read' ? 'Read' : 'Write'],
      security: [{ bearer: [t.kind === 'read' ? SCOPES.read : SCOPES.write] }],
      'x-mcp-tool': t.name,
      responses: {
        [t.kind === 'write' ? '201' : '200']: { description: t.kind === 'write' ? 'Recorded (or duplicate: 200)' : 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
        ...(t.kind === 'write' ? { '202': { description: 'Waiting for review' } } : {}),
        '400': { $ref: '#/components/responses/Error' },
        '401': { $ref: '#/components/responses/Error' },
        '403': { $ref: '#/components/responses/Error' },
        '404': { $ref: '#/components/responses/Error' },
        '409': { $ref: '#/components/responses/Error' },
        '423': { $ref: '#/components/responses/Error' },
        '429': { $ref: '#/components/responses/Error' },
      },
    }
    if (t.rest.method === 'GET') {
      for (const [name, s] of Object.entries(props)) {
        if (pathParams.includes(name)) continue
        const isObject = s.type === 'object'
        parameters.push(isObject ? { name, in: 'query', required: required.has(name), description: s.description, content: { 'application/json': { schema: s } } } : { name, in: 'query', required: required.has(name), description: s.description, schema: s, ...(s.type === 'array' ? { style: 'form', explode: false } : {}) })
      }
    } else {
      const bodyProps = Object.fromEntries(Object.entries(props).filter(([k]) => !pathParams.includes(k)))
      op.requestBody = { required: true, content: { 'application/json': { schema: { ...schema, properties: bodyProps, required: [...required].filter((k) => !pathParams.includes(k)) } } } }
      parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, description: 'Alternative to idempotency_key in the body.', schema: { type: 'string' } })
    }
    op.parameters = parameters
    const path = paths[t.rest.path] ?? {}
    path[t.rest.method.toLowerCase()] = op
    paths[t.rest.path] = path
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Aggregate API', version: SERVER_INFO.version, description: 'The same operations as the Aggregate MCP tools. Money is {amount: "1234.56", currency: "USD"}. Nothing here moves money or contacts anyone.', license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' } },
    servers: [{ url: origin }],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'An OAuth access token for this server, or an agent key (agfn_live_…).' } },
      responses: {
        Error: {
          description: 'Error',
          content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' } }, required: ['error', 'message'] } } },
        },
      },
    },
  }
}
