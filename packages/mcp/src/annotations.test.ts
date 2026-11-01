// Directory reviews reject servers with missing or wrong tool annotations (Anthropic's most common rejection). This fails
// the build if a tool ships without a title or with hints that don't match what it does.
import { describe, expect, it } from 'vitest'
import { annotations } from './mcp-server.ts'
import { ALL_TOOLS } from './service.ts'

const DESTRUCTIVE = ['void_record', 'close_period', 'reopen_period', 'update_record', 'update_bucket', 'resolve_review_item']

describe('tool annotations', () => {
  it('every tool has a title and explicit boolean hints', () => {
    for (const t of ALL_TOOLS) {
      const a = annotations(t)
      expect(a.title?.trim(), t.name).toBeTruthy()
      for (const h of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) expect(typeof a[h], `${t.name}.${h}`).toBe('boolean')
      expect(a.openWorldHint, t.name).toBe(t.name === 'refresh_balance') // the one tool that asks a bank live
    }
  })

  it('reads are read-only and never destructive; writes are not read-only', () => {
    for (const t of ALL_TOOLS) {
      const a = annotations(t)
      if (/^(get|list|query|search)_/.test(t.name) || t.name === 'whoami') expect([t.name, a.readOnlyHint, a.destructiveHint]).toEqual([t.name, true, false])
      if (/^(add|record|create|update|void|close|reopen|resolve|pin)_/.test(t.name)) expect([t.name, a.readOnlyHint]).toEqual([t.name, false])
    }
  })

  it('exactly the tools that change or remove an existing record are destructive', () => {
    expect(ALL_TOOLS.filter((t) => annotations(t).destructiveHint).map((t) => t.name).sort()).toEqual([...DESTRUCTIVE].sort())
  })
})
