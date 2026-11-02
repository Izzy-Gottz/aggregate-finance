import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { ALL_TOOLS, TOOLS_WITH_SET_ASIDES } from './service.ts'

const find = (tools: typeof ALL_TOOLS, name: string) => tools.find((t) => t.name === name)!
const keys = (t: (typeof ALL_TOOLS)[number]) => Object.keys((t.input as z.ZodObject).shape).sort()

describe('the set-aside overlay', () => {
  it.each(['create_bucket', 'update_bucket'])('%s is the off version plus set_aside', (name) => {
    const off = find(ALL_TOOLS, name)
    const on = find(TOOLS_WITH_SET_ASIDES, name)
    expect(keys(on)).toEqual([...keys(off), 'set_aside'].sort())
    expect(on.output).toBe(off.output)
  })
})
