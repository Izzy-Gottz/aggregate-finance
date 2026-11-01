import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { UsageError, type Io } from './io.ts'
import { demoLocalCommand } from './demo-local.ts'

const dir = mkdtempSync(join(tmpdir(), 'agfn-demo-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function io(cwd: string): Io & { lines: string[] } {
  const lines: string[] = []
  return { env: { AGFN_DEMO_DIR: join(dir, 'data') }, cwd, lines, out: (l) => void lines.push(l), err: (l) => void lines.push(l) }
}

describe('agfn demo (local)', () => {
  it('starts with sample data, prints the Claude Code line, and reuses the key next time', async () => {
    const cwd = mkdtempSync(join(dir, 'cwd-'))
    const first = io(cwd)
    expect(await demoLocalCommand(['--port', '8831'], first, { exitAfterReady: true, fillTimeoutMs: 120_000 })).toBe(0)
    const text = first.lines.join('\n')
    expect(text).toContain('Aggregate demo is running at http://localhost:8831')
    expect(text).toContain('Northwind Labs')
    const line = /claude mcp add --transport http aggregate-demo http:\/\/localhost:8831\/mcp --header "Authorization: Bearer (\S+)"/.exec(text)
    expect(line).not.toBeNull()
    expect(text).toMatch(/http:\/\/localhost:8831\/api\/auth\/magic-link\/verify\?token=/)
    // Nothing lands in the folder it was run from; the saved keys are private to the person.
    expect(readdirSync(cwd)).toEqual([])
    const data = join(dir, 'data')
    expect(statSync(data).mode & 0o777).toBe(0o700)
    expect(statSync(join(data, 'demo.json')).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(join(data, 'demo.json'), 'utf8')).agentKey).toBe(line![1])

    const again = io(cwd)
    expect(await demoLocalCommand(['--port', '8831'], again, { exitAfterReady: true })).toBe(0)
    expect(again.lines.join('\n')).toContain(`Bearer ${line![1]}"`)
    expect(again.lines.join('\n')).not.toContain('fills in within a minute')
  }, 180_000)

  it('rejects a port that is not a number', async () => {
    await expect(demoLocalCommand(['--port', 'abc'], io(dir))).rejects.toBeInstanceOf(UsageError)
  })
})
