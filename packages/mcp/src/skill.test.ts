import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { METRICS } from './tools/read.ts'
import { ALL_TOOLS } from './service.ts'

// The agent skill (skills/aggregate/SKILL.md, installed with `npx skills add`) repeats the fixed definitions and names
// tools: it must not drift from what the server says.
const skill = readFileSync(new URL('../../../skills/aggregate/SKILL.md', import.meta.url), 'utf8')

describe('skills/aggregate/SKILL.md', () => {
  it('has every metric with the definition the server gives', () => {
    for (const [name, m] of Object.entries(METRICS)) expect(skill).toContain(`| \`${name}\` | ${m.definition} |`)
  })

  it('names only tools that exist', () => {
    const tools = new Set(ALL_TOOLS.map((t) => t.name))
    const named = [...skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!).filter((n) => /^(get|list|query|search|add|record|create|update|resolve|void|pin|close|reopen|refresh)_/.test(n))
    expect(named.length).toBeGreaterThan(20)
    for (const n of named) expect(tools, n).toContain(n)
  })

  it('has the frontmatter skills.sh needs', () => {
    expect(skill).toMatch(/^---\nname: aggregate\ndescription: .{40,1024}\n---\n/)
  })
})
