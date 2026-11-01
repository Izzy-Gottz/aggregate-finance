// @agfn/mcp: the MCP server, REST API, grants, agent keys, write pipeline and activity log (slice S7).
//
//   const agfn = createAgfnMcp({ db, reader, writer, people: peopleFromAuth({...}), verifier, hooks }, { resourceUrl })
//   app.all('/mcp', (c) => agfn.fetch(c.req.raw))                      // + /.well-known/oauth-protected-resource/mcp, /v1/*
//   await agfn.control.createGrant(person, { clientId, clientName, kind: 'oauth', shape })   // consent screen
//   await agfn.pipeline.submit({ actor: { kind: 'person', … }, origin: 'ui', … })            // UI writes

import { AgfnHttp, type HttpOptions } from './http.ts'
import { AgfnMcp, type AgfnMcpDeps } from './service.ts'

export interface AgfnMcpHandle {
  service: AgfnMcp
  http: AgfnHttp
  fetch: (req: Request) => Promise<Response>
  control: AgfnMcp['control']
  pipeline: AgfnMcp['pipeline']
  ui: AgfnMcp['ui']
}

export function createAgfnMcp(deps: AgfnMcpDeps, http: HttpOptions): AgfnMcpHandle {
  const service = new AgfnMcp(deps)
  const h = new AgfnHttp(service, http)
  return { service, http: h, fetch: h.fetch, control: service.control, pipeline: service.pipeline, ui: service.ui }
}

export { AgfnMcp, ALL_TOOLS, SCOPES, grantScopes, PUBLIC_DEMO_CLIENT, PUBLIC_DEMO_READ_ONLY, type AgfnMcpDeps, type RequestMeta, type AuthOutcome, type CallOutcome } from './service.ts'
export { AgfnHttp, parseShape, parseGrantShape, type HttpOptions } from './http.ts'
export { ControlApi, PASSKEY_WINDOW_MS, type PersonActor, type GrantSummary, type CreatedKey, type PendingWrite } from './control.ts'
export { WritePipeline, UNDO_DAYS, payloadHash, type WriteActor, type SubmitWrite, type PipelineResult } from './writes.ts'
export { controlSentence, defaultGrantShape, publicDemoGrantShape, ALL_DATA_TYPES, grantCovers, grantState, isWidening, normalizeShape, NEVER_LINE, type Grant, type ControlSentence, type SentencePart } from './grants.ts'
export { appendActivity, listActivity, verifyChain, redactArgs, type ActivityRow, type ActivityInput } from './activity.ts'
export { generateKey, hashKey, looksLikeAgentKey, KEY_PREFIX } from './keys.ts'
export { clean, detectInjection, untrusted, UNTRUSTED_NOTE, type UntrustedText } from './untrusted.ts'
export { parseMoney, wire, currencyExponent } from './money.ts'
export { buildMcpServer, SERVER_INFO } from './mcp-server.ts'
export { buildOpenApi } from './openapi.ts'
export { serveLocal, runBridge, connectRemote, bridgeServer } from './stdio.ts'
export { peopleFromAuth, type AuthPermissions, type AuthReauth } from './host.ts'
export { ToolError, type Principal } from './scope.ts'
export { DbRateLimiter, MemoryRateLimiter, DEFAULT_RATE_LIMITS, type RateLimiter, type RateLimits } from './ratelimit.ts'
export { WRITE_RULES } from './tools/write.ts'
export { AiUi, describeWrite, applyEdits, type AiSummary, type AiDetail, type AiActivity, type AiWorkspaceSummary, type UiReviewItem, type ReviewDecision, type CashEntry, type BucketDetail, type BucketPatch } from './ui.ts'
export type { McpTables, GrantsTable, AgentKeysTable, WriteRequestsTable, ActivityLogTable, AiSettingsTable } from './store/schema.ts'
export * from './ports.ts'
